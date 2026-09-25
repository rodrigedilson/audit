import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { PostgresEventStoreRepository } from '../../infrastructure/persistence/postgres-event-store.repository.js';
import { EventReplayerService } from '../../esaa/core/event-store/event-replayer.service.js';
import { FiscalProjectorService } from '../../fiscal/projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../../fiscal/projection/fiscal-hash-verifier.service.js';
import { inferActorType } from '../actor-type.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { IntegrityProofService, ProofPeriodNotFoundError } from '../../fiscal/reporting/integrity-proof.service.js';
import { renderIntegrityProofPdf } from '../../fiscal/reporting/integrity-proof-pdf.js';

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface EventsQuery {
  after_seq?: number;
  page_size?: number;
  action?: string;
}

export async function registerEventRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get<{ Params: CnpjParams; Querystring: EventsQuery }>(
    '/clients/:cnpj/events',
    {
      schema: {
        params: CNPJ_PARAM,
        querystring: {
          type: 'object',
          properties: {
            after_seq: { type: 'integer', minimum: 0 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            action: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const pageSize = request.query.page_size ?? 50;

      const { rows } = await deps.pool.query(
        `select event_id, event_seq, ts as occurred_at, action, actor,
                cnpj, period, payload
           from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)
            and ($3::bigint is null or event_seq > $3::bigint)
            and ($4::text is null or action = $4::text)
          order by event_seq asc
          limit $5`,
        [
          scope.tenantId,
          scope.cnpj,
          request.query.after_seq ?? null,
          request.query.action ?? null,
          pageSize,
        ],
      );

      return reply.code(200).send(
        rows.map((row: Record<string, unknown>) => ({
          ...row,
          event_seq: Number(row['event_seq']),
          actor: { type: inferActorType(String(row['actor'])), id: row['actor'] },
        })),
      );
    },
  );

  /**
   * Resumo da trilha: quais ações existem neste log, e quantas.
   *
   * Existe para o filtro da trilha oferecer **só o que está no log**. A
   * alternativa era a tela listar o vocabulário fiscal inteiro — 30 ações, das
   * quais a maioria nunca ocorreu naquele CNPJ — e o contador escolher um
   * filtro que devolve vazio sem saber se é porque não houve ou porque errou.
   *
   * Também responde de relance o que aconteceu no CNPJ: 578 `doc.received` e 4
   * `output.rejected` é uma frase inteira sobre o mês.
   */
  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/events/summary',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const { rows } = await deps.pool.query<{
        action: string;
        count: string;
        last_seq: string;
        last_ts: Date;
      }>(
        `select action, count(*) as count,
                max(event_seq) as last_seq, max(ts) as last_ts
           from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)
          group by action
          order by count(*) desc, action`,
        [scope.tenantId, scope.cnpj],
      );

      return reply.code(200).send({
        actions: rows.map((row) => ({
          action: row.action,
          count: Number(row.count),
          last_seq: Number(row.last_seq),
          last_ts: row.last_ts,
        })),
        total: rows.reduce((soma, row) => soma + Number(row.count), 0),
      });
    },
  );

  /**
   * `GET /clients/{cnpj}/periods/{period}/proof` — comprovante de integridade.
   *
   * O `POST /verify` já fazia a parte difícil, mas responde sobre o CNPJ inteiro
   * e serve a quem está depurando. Este é o entregável: o documento de uma
   * competência que o escritório mostra ao cliente dele, dizendo qual número foi
   * apurado, sobre quantos documentos, e provando que a trilha fecha.
   *
   * A verificabilidade é o que o produto tem de diferente, e não estava visível em
   * lugar nenhum — ficava atrás de um POST que ninguém chamaria por conta própria.
   * `?format=pdf` devolve o mesmo comprovante em PDF, com o hash no rodapé de
   * cada página e o SHA-256 do arquivo em `x-pdf-sha256`. Só leitura: não grava
   * evento.
   */
  app.get<{ Params: CnpjParams & { period: string }; Querystring: { format?: 'json' | 'pdf' } }>(
    '/clients/:cnpj/periods/:period/proof',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['json', 'pdf'], default: 'json' } },
        },
        params: {
          type: 'object',
          required: ['cnpj', 'period'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      let proof;
      try {
        proof = await new IntegrityProofService(deps.pool).build(scope, request.params.period);
      } catch (erro) {
        if (erro instanceof ProofPeriodNotFoundError) throw new NotFoundError(erro.message);
        throw erro;
      }

      if (request.query.format !== 'pdf') {
        return reply.code(200).send(proof);
      }

      // Só leitura, sem evento: o PDF é a mesma prova, renderizada. O SHA-256 do
      // arquivo vai no cabeçalho para quem guarda o PDF poder conferi-lo depois.
      const { rows } = await deps.pool.query<{ legal_name: string | null }>(
        'select legal_name from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
        [scope.tenantId, scope.cnpj],
      );
      const pdf = await renderIntegrityProofPdf(proof, {
        tenantName: request.tenant.tenantName,
        legalName: rows[0]?.legal_name ?? scope.cnpj,
      });
      return reply
        .code(200)
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="comprovante-${scope.cnpj}-${proof.period}.pdf"`)
        .header('x-pdf-sha256', pdf.sha256)
        .send(pdf.pdf);
    },
  );

  /**
   * `POST /clients/{cnpj}/verify` — INV-006. Reprojeta o log do zero, de
   * propósito: é o único caminho que não confia em snapshot nenhum, e por isso o
   * único que serve como prova.
   */
  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/verify',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const repo = new PostgresEventStoreRepository(deps.pool, scope);
      const events = await new EventReplayerService(repo).replayAll();

      const projector = new FiscalProjectorService();
      const projection = projector.project(scope.tenantId, scope.cnpj, events);
      const verification = new FiscalHashVerifierService(projector).verify(events, projection);

      return reply.code(200).send({
        ok: verification.valid,
        stored_hash: verification.storedHash,
        replayed_hash: verification.replayHash,
        last_event_seq: projection.last_event_seq,
      });
    },
  );
}
