import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { inferActorType } from '../actor-type.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import {
  CertificateError,
  CertificateVault,
  daysToExpiry,
  readCertificateMetadata,
  extrairCredencial,
} from '../../fiscal/portfolio/certificate-vault.js';

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
} as const;

interface CnpjParams {
  cnpj: string;
}

/** 5 MB cobre com folga um A1; o limite evita upload usado como vetor de carga. */
const MAX_PFX_BYTES = 5 * 1024 * 1024;

export async function registerCertificateRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const vault = new CertificateVault(
    deps.env.certificateMasterKey,
    deps.env.certificateMasterKeyPrevious,
  );

  /** Metadados. **Nunca** devolve o PFX — a coluna nem é selecionada. */
  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/certificate',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const { rows } = await deps.pool.query<{
        subject: string;
        issuer: string;
        serial: string;
        valid_from: Date;
        valid_to: Date;
        stored_at: Date;
        stored_by: string;
        credential_format: string;
      }>(
        `select subject, issuer, serial, valid_from, valid_to, stored_at, stored_by, credential_format
           from certificates
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [scope.tenantId, scope.cnpj],
      );

      const certificate = rows[0];
      if (!certificate) {
        throw new NotFoundError(`CNPJ ${scope.cnpj} não tem certificado armazenado.`);
      }

      const orchestrator = await deps.orchestratorFor(scope);
      const projection = await orchestrator.getProjection();

      return reply.code(200).send({
        cnpj: scope.cnpj,
        subject: certificate.subject,
        issuer: certificate.issuer,
        serial: certificate.serial,
        valid_from: certificate.valid_from.toISOString(),
        valid_to: certificate.valid_to.toISOString(),
        days_to_expiry: daysToExpiry(certificate.valid_to.toISOString()),
        stored_at: certificate.stored_at.toISOString(),
        stored_by: certificate.stored_by,
        last_used_at: projection.certificate?.last_used_at ?? null,
        /**
         * Usos desde que **este** certificado foi guardado.
         *
         * O campo se chamava `usage_count_30d` e contava tudo: a projeção
         * incrementa a cada `certificate.used` e zera quando um novo PFX
         * substitui o anterior. Nenhuma janela de 30 dias em lugar algum — o
         * nome afirmava um recorte que ninguém calculava.
         */
        usage_count: projection.certificate?.usage_count ?? 0,
        // Certificado enviado antes da coleta de DF-e foi guardado como PFX com
        // senha descartada, e não abre: precisa ser reenviado (ADR-006).
        usable_for_sync: certificate.credential_format === 'pem_bundle',
      });
    },
  );

  /**
   * Armazena ou substitui o certificado. Emite `certificate.stored`.
   *
   * Só `owner`: quem guarda o A1 de um cliente pode agir em nome dele perante o
   * Fisco.
   */
  app.put<{ Params: CnpjParams }>(
    '/clients/:cnpj/certificate',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { pfx, password } = await readUpload(request);

      let metadata;
      let credencial: Buffer;
      try {
        metadata = readCertificateMetadata(pfx, password);
        // O que se guarda é a credencial, e não o PFX: a senha que o protege
        // não é guardada, e sem ela o PFX não abriria na coleta (ADR-006).
        credencial = extrairCredencial(pfx, password);
      } catch (cause) {
        if (cause instanceof CertificateError) {
          throw new ValidationError(2, 'schema_violation', cause.message);
        }
        throw cause;
      }

      const encrypted = vault.encrypt(credencial);

      // O evento vem primeiro: é a fonte da verdade. A tabela guarda o material
      // cifrado, que não cabe no log — um PFX de 4 KB em base64 dentro de um
      // event log append-only inflaria o replay para sempre.
      const orchestrator = await deps.orchestratorFor(scope);
      const result = await orchestrator.processIntention({
        action: 'certificate.stored',
        task_id: scope.cnpj,
        actor: context.user.userId,
        payload: { ...metadata, fingerprint: encrypted.fingerprint },
      });

      if (!result.accepted) {
        throw new ValidationError(
          result.layer ?? 3,
          'schema_violation',
          result.rejectionReason ?? 'Armazenamento rejeitado pelo pipeline.',
        );
      }

      await deps.pool.query(
        `insert into certificates (
           tenant_id, cnpj, encrypted_pfx, fingerprint, key_id, subject, issuer, serial,
           valid_from, valid_to, stored_by, credential_format
         ) values ($1::uuid, $2::char(14), $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::uuid, 'pem_bundle')
         on conflict (tenant_id, cnpj) do update set
           encrypted_pfx = excluded.encrypted_pfx,
           credential_format = excluded.credential_format,
           fingerprint = excluded.fingerprint,
           key_id = excluded.key_id,
           subject = excluded.subject,
           issuer = excluded.issuer,
           serial = excluded.serial,
           valid_from = excluded.valid_from,
           valid_to = excluded.valid_to,
           stored_at = now(),
           stored_by = excluded.stored_by`,
        [
          scope.tenantId,
          scope.cnpj,
          encrypted.ciphertext,
          encrypted.fingerprint,
          encrypted.keyId,
          metadata.subject,
          metadata.issuer,
          metadata.serial,
          metadata.valid_from,
          metadata.valid_to,
          context.user.userId,
        ],
      );

      return reply.code(200).send({
        event_id: result.event!.event_id,
        event_seq: result.event!.event_seq,
        action: result.event!.action,
        projection_hash: result.projection!.projection_hash_sha256,
      });
    },
  );

  app.delete<{ Params: CnpjParams }>(
    '/clients/:cnpj/certificate',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const orchestrator = await deps.orchestratorFor(scope);

      const result = await orchestrator.processIntention({
        action: 'certificate.removed',
        task_id: scope.cnpj,
        actor: context.user.userId,
        payload: {},
      });

      await deps.pool.query(
        'delete from certificates where tenant_id = $1::uuid and cnpj = $2::char(14)',
        [scope.tenantId, scope.cnpj],
      );

      return reply.code(200).send({
        event_id: result.event!.event_id,
        event_seq: result.event!.event_seq,
        action: result.event!.action,
        projection_hash: result.projection!.projection_hash_sha256,
      });
    },
  );

  /** Log de uso — projeção dos eventos `certificate.used`. */
  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/certificate/usage',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const { rows } = await deps.pool.query(
        `select event_seq, ts as used_at, actor, payload,
                -- A janela conta antes do limit: rows.length devolvia 200 num
                -- CNPJ com 500 usos, e a tela diria que sao 200. Trilha de uso
                -- do A1 com total errado nao serve de trilha.
                count(*) over () as total
           from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)
            and action = 'certificate.used'
          order by event_seq desc
          limit 200`,
        [scope.tenantId, scope.cnpj],
      );

      return reply.code(200).send({
        items: rows.map((row: Record<string, unknown>) => {
          const payload = row['payload'] as Record<string, unknown>;
          return {
            event_seq: Number(row['event_seq']),
            used_at: row['used_at'],
            // Inferido, e não fixo em 'agent': o uso disparado por uma pessoa
            // aparecia como uso de agente, e este log existe exatamente para
            // dizer quem agiu em nome do cliente perante o Fisco.
            actor: { type: inferActorType(String(row['actor'])), id: row['actor'] },
            purpose: payload['purpose'],
            target: payload['target'],
            outcome: payload['outcome'],
            ip: payload['ip'] ?? null,
          };
        }),
        total: Number(rows[0]?.['total'] ?? 0),
      });
    },
  );

  /**
   * Certificados da carteira vencendo. É o alerta que evita a coleta de DF-e
   * parar sem ninguém perceber.
   */
  app.get<{ Querystring: { days?: number } }>(
    '/certificates/expiring',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 60 } },
        },
      },
    },
    async (request, reply) => {
      const days = request.query.days ?? 60;

      const { rows } = await deps.pool.query(
        `select cnpj, subject, issuer, serial, valid_from, valid_to, stored_at, stored_by
           from certificates
          where tenant_id = $1::uuid
            and valid_to <= now() + ($2 || ' days')::interval
          order by valid_to asc`,
        [request.tenant.tenantId, String(days)],
      );

      return reply.code(200).send(
        rows.map((row: Record<string, unknown>) => ({
          ...row,
          days_to_expiry: daysToExpiry(new Date(row['valid_to'] as string).toISOString()),
        })),
      );
    },
  );
}

interface Upload {
  pfx: Buffer;
  password: string;
}

/**
 * Lê o multipart do contrato (`pfx` + `password`). A senha é usada só para abrir
 * o arquivo e **não** é persistida: guardá-la ao lado do PFX cifrado anularia a
 * cifragem.
 */
async function readUpload(request: {
  parts: () => AsyncIterableIterator<
    | { type: 'file'; fieldname: string; toBuffer: () => Promise<Buffer> }
    | { type: 'field'; fieldname: string; value: unknown }
  >;
}): Promise<Upload> {
  let pfx: Buffer | undefined;
  let password: string | undefined;

  for await (const part of request.parts()) {
    if (part.type === 'file' && part.fieldname === 'pfx') {
      pfx = await part.toBuffer();
    } else if (part.type === 'field' && part.fieldname === 'password') {
      password = String(part.value);
    }
  }

  if (!pfx || pfx.length === 0) {
    throw new ValidationError(1, 'schema_violation', 'Arquivo PFX ausente no campo "pfx".');
  }
  if (pfx.length > MAX_PFX_BYTES) {
    throw new ValidationError(1, 'schema_violation', 'Arquivo PFX maior que 5 MB.');
  }
  if (!password) {
    throw new ValidationError(1, 'schema_violation', 'Senha do certificado ausente.');
  }

  return { pfx, password };
}
