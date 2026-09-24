import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { IngestionService, type UploadedFile } from '../../fiscal/ingestion/ingestion.service.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';

interface CnpjParams {
  cnpj: string;
}

/** 200 arquivos por requisição; acima disso o caminho é o job assíncrono. */
const MAX_FILES_PER_UPLOAD = 200;

export async function registerIngestionRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  /**
   * Upload manual de XML. Responde **207 Multi-Status**: o escritório sobe o mês
   * inteiro, e uma nota com problema não pode impedir as outras de entrarem.
   * Cada rejeição vira `output.rejected` no log, com camada e motivo.
   */
  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/documents',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj'],
          properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const files = await readXmlFiles(request);

      const orchestrator = await deps.orchestratorFor(scope);
      const ingestion = new IngestionService(deps.pool, orchestrator, scope);

      const result = await ingestion.ingestXmlBatch(files, context.user.userId);

      // 207 mesmo quando tudo passou: o formato da resposta é o mesmo, e variar
      // o status faria o cliente ter dois caminhos de parsing.
      return reply.code(207).send(result);
    },
  );

  app.get<{
    Params: CnpjParams;
    Querystring: {
      period?: string;
      page?: number;
      page_size?: number;
      direction?: 'inbound' | 'outbound';
      has_reform_group?: boolean;
    };
  }>(
    '/clients/:cnpj/documents',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj'],
          properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
        },
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
            page: { type: 'integer', minimum: 1, default: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            direction: { type: 'string', enum: ['inbound', 'outbound'] },
            has_reform_group: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const page = request.query.page ?? 1;
      const pageSize = request.query.page_size ?? 50;

      const { rows } = await deps.pool.query(
        `select access_key, model, direction, series, number, issued_at, period,
                counterparty_cnpj, counterparty_name, total_cents, has_reform_group,
                event_seq, count(*) over () as total
           from documents
          where tenant_id = $1::uuid and cnpj = $2::char(14)
            and ($3::char(7) is null or period = $3::char(7))
            and ($4::text is null or direction = $4::text)
            and ($5::boolean is null or has_reform_group = $5::boolean)
          order by issued_at desc
          limit $6 offset $7`,
        [
          scope.tenantId,
          scope.cnpj,
          request.query.period ?? null,
          request.query.direction ?? null,
          request.query.has_reform_group ?? null,
          pageSize,
          (page - 1) * pageSize,
        ],
      );

      return reply.code(200).send({
        items: rows.map((row: Record<string, unknown>) => ({
          ...withoutTotal(row),
          total_cents: Number(row['total_cents']),
          event_seq: Number(row['event_seq']),
        })),
        page,
        total: Number(rows[0]?.['total'] ?? 0),
      });
    },
  );

  /**
   * Documento com itens, tributos atuais e IBS/CBS lado a lado — é a tela que
   * materializa a apuração dual por item.
   */
  app.get<{ Params: CnpjParams & { access_key: string } }>(
    '/clients/:cnpj/documents/:access_key',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj', 'access_key'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            access_key: { type: 'string', pattern: '^[0-9]{44}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const { access_key: accessKey } = request.params;

      const { rows } = await deps.pool.query(
        `select access_key, model, direction, series, number, issued_at, period,
                issuer_cnpj, issuer_name, counterparty_cnpj, counterparty_name,
                total_cents, has_reform_group, event_seq
           from documents
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3::char(44)`,
        [scope.tenantId, scope.cnpj, accessKey],
      );

      const document = rows[0];
      if (!document) {
        throw new NotFoundError(`Documento ${accessKey} não encontrado para este CNPJ.`);
      }

      const { rows: items } = await deps.pool.query(
        `select line, code, description, ncm, cfop, unit, quantity,
                unit_price_cents, total_cents, legacy_taxes, reform_taxes
           from document_items
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3::char(44)
          order by line`,
        [scope.tenantId, scope.cnpj, accessKey],
      );

      return reply.code(200).send({
        ...document,
        total_cents: Number(document['total_cents']),
        event_seq: Number(document['event_seq']),
        items: items.map((item: Record<string, unknown>) => ({
          ...item,
          quantity: Number(item['quantity']),
          unit_price_cents: Number(item['unit_price_cents']),
          total_cents: Number(item['total_cents']),
        })),
      });
    },
  );

  app.get<{ Params: { job_id: string } }>(
    '/jobs/:job_id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['job_id'],
          properties: { job_id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { rows } = await deps.pool.query(
        `select id as job_id, kind, status, progress, accepted, rejected, error,
                created_at, finished_at
           from jobs where id = $1::uuid and tenant_id = $2::uuid`,
        [request.params.job_id, request.tenant.tenantId],
      );

      const job = rows[0];
      if (!job) {
        // 404 e não 403 para job de outro escritório, pela mesma razão do CNPJ:
        // confirmar existência é vazamento.
        throw new NotFoundError('Job não encontrado.');
      }

      return reply.code(200).send(job);
    },
  );

  /**
   * Coleta na distribuição DF-e. Depende de fonte externa — certificado A1
   * contra o webservice da SEFAZ — e o worker que consome a fila entra junto da
   * coleta real. Enfileirar sem consumidor seria pior do que dizer que ainda não
   * está pronto, porque o escritório ficaria esperando um job que nunca sai de
   * `queued`.
   *
   * Duas importações saíram desta lista, porque deixaram de ser promessa:
   * o extrato bancário na Onda 10 (`POST /bank-statements`, OFX ou CSV) e a
   * EFD-Contribuições na Onda 12 (`POST /sped`, upload do arquivo que o cliente
   * já gera). Nos dois casos o caminho automático continua desejável, e quando
   * existir entra como outra origem do mesmo módulo.
   */
  for (const [path, kind] of [['sync', 'dfe_sync']] as const) {
    app.post<{ Params: CnpjParams }>(
      `/clients/:cnpj/${path}`,
      {
        schema: {
          params: {
            type: 'object',
            required: ['cnpj'],
            properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
          },
        },
      },
      async (request, reply) => {
        const context = request.tenant;
        deps.tenantResolver.assertCanWrite(context);
        await deps.tenantResolver.scopeFor(context, request.params.cnpj);

        return reply.code(501).send({
          code: 'not_implemented',
          message:
            `Importação '${kind}' ainda não está disponível. ` +
            'Use o upload manual de XML em POST /clients/{cnpj}/documents.',
        });
      },
    );
  }
}

/**
 * Lê os XMLs do multipart. Rejeita o lote inteiro só por problema de forma
 * (nenhum arquivo, excesso de arquivos); conteúdo inválido é decidido por
 * arquivo, no 207.
 */
async function readXmlFiles(request: FastifyRequest): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];

  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      continue;
    }
    if (files.length >= MAX_FILES_PER_UPLOAD) {
      throw new ValidationError(
        1,
        'schema_violation',
        `Máximo de ${MAX_FILES_PER_UPLOAD} arquivos por requisição.`,
      );
    }
    files.push({
      filename: part.filename ?? `arquivo-${files.length + 1}.xml`,
      content: (await part.toBuffer()).toString('utf8'),
    });
  }

  if (files.length === 0) {
    throw new ValidationError(1, 'schema_violation', 'Nenhum arquivo XML enviado.');
  }

  return files;
}

function withoutTotal(row: Record<string, unknown>): Record<string, unknown> {
  const { total: _ignored, ...rest } = row;
  return rest;
}
