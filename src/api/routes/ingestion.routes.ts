import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { IngestionService } from '../../fiscal/ingestion/ingestion.service.js';
import { readXmlUpload } from '../multipart.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';
import { PADRAO_DA_CHAVE } from '../../fiscal/ingestion/access-key.js';
import { CANCELAMENTO_EXIGE_RETIFICACAO } from '../../fiscal/dfe/dfe-sync.service.js';
import { autoSync, setAutoSync } from '../../fiscal/dfe/dfe-auto-sync.js';

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
      const { files } = await readXmlUpload(request, {
        maxFiles: MAX_FILES_PER_UPLOAD,
        maxTotalBytes: MAX_FILES_PER_UPLOAD * 5 * 1024 * 1024,
      });

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
                event_seq, cancelled_at, count(*) over () as total
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
            access_key: { type: 'string', pattern: PADRAO_DA_CHAVE },
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
                total_cents, has_reform_group, event_seq, cancelled_at, cancel_protocol
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
                result, created_at, started_at, finished_at
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
   * Coleta na distribuição DF-e (ADR-006). Enfileira e responde 202: o worker
   * do processo consome a fila, consulta a SEFAZ por NSU com o A1 do cliente,
   * ingere as NF-e completas pelo mesmo caminho do upload e registra a ciência
   * da operação dos resumos de entrada.
   *
   * Em dev não há gateway, e a rota responde 503: o banco é o de produção.
   */
  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/sync',
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

      if (deps.dfe === undefined) {
        return reply.code(503).send({
          code: 'dfe_gateway_not_configured',
          message:
            'Coleta de DF-e indisponível neste ambiente. Em dev isso é esperado: o banco é ' +
            'compartilhado com produção, e dev não fala com a SEFAZ. Use o upload manual em ' +
            'POST /clients/{cnpj}/documents.',
        });
      }

      const job = await deps.dfe.enqueue(scope, context.user.userId);
      const { rows } = await deps.pool.query(
        `select id as job_id, kind, status, progress, accepted, rejected, error,
                result, created_at, started_at, finished_at
           from jobs where id = $1::uuid`,
        [job.jobId],
      );
      // O mesmo `Job` de GET /jobs/{job_id}, mais `reused`: pedir de novo com
      // coleta pendente devolve a mesma, em vez de enfileirar outra.
      return reply.code(202).send({ ...rows[0], reused: job.reused });
    },
  );

  /** Estado da coleta: último NSU, próxima consulta permitida e resumos sem XML. */
  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/dfe',
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
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const [estado, resumos, documentos, eventos, agendada] = await Promise.all([
        deps.pool.query(
          `select ult_nsu, max_nsu, last_cstat, last_motivo, last_run_at, blocked_until
             from dfe_sync_state where tenant_id = $1::uuid and cnpj = $2::char(14)`,
          [scope.tenantId, scope.cnpj],
        ),
        deps.pool.query<{ aguardando_ciencia: string; aguardando_xml: string; com_falha: string }>(
          `select count(*) filter (where manifested_at is null and received_at is null and manifest_cstat is null)::text as aguardando_ciencia,
                  count(*) filter (where manifested_at is not null and received_at is null)::text as aguardando_xml,
                  count(*) filter (where manifested_at is null and manifest_cstat is not null)::text as com_falha
             from dfe_summaries where tenant_id = $1::uuid and cnpj = $2::char(14)`,
          [scope.tenantId, scope.cnpj],
        ),
        deps.pool.query<{ aguardando: string; recusados: string }>(
          `select count(*) filter (where ingested_at is null and ingest_error is null)::text as aguardando,
                  count(*) filter (where ingest_error is not null)::text as recusados
             from dfe_documents where tenant_id = $1::uuid and cnpj = $2::char(14)`,
          [scope.tenantId, scope.cnpj],
        ),
        deps.pool.query<{ access_key: string; tp_evento: string; protocolo: string | null; dh_evento: Date | null }>(
          `select access_key, tp_evento, protocolo, dh_evento
             from dfe_events
            where tenant_id = $1::uuid and cnpj = $2::char(14) and blocked_reason = $3
            order by dh_evento`,
          [scope.tenantId, scope.cnpj, CANCELAMENTO_EXIGE_RETIFICACAO],
        ),
        autoSync(deps.pool, scope),
      ]);
      const d = documentos.rows[0]!;
      const e = estado.rows[0];
      const r = resumos.rows[0]!;
      return reply.code(200).send({
        cnpj: scope.cnpj,
        available: deps.dfe !== undefined,
        ult_nsu: e?.ult_nsu ?? null,
        max_nsu: e?.max_nsu ?? null,
        last_cstat: e?.last_cstat ?? null,
        last_message: e?.last_motivo ?? null,
        last_run_at: e?.last_run_at ?? null,
        next_allowed_at: e?.blocked_until ?? null,
        summaries: {
          awaiting_acknowledgement: Number(r.aguardando_ciencia),
          awaiting_full_xml: Number(r.aguardando_xml),
          acknowledgement_failed: Number(r.com_falha),
        },
        documents: {
          // NF-e baixada de competência ainda não aberta: entra na coleta
          // seguinte à abertura, e não vira rejeição no log.
          awaiting_period_open: Number(d.aguardando),
          rejected_by_pipeline: Number(d.recusados),
        },
        // Nota cancelada na SEFAZ depois de a competência ser confirmada. O número
        // confirmado não muda sozinho (INV-001): a correção é a retificação.
        // Coleta agendada (ADR-007): quem ligou e quando.
        auto_sync: agendada,
        cancellations_needing_rectification: eventos.rows.map((x) => ({
          access_key: x.access_key,
          tp_evento: x.tp_evento,
          protocol: x.protocolo,
          cancelled_at: x.dh_evento,
        })),
      });
    },
  );

  /**
   * Liga ou desliga a coleta agendada (ADR-007). Só o owner: é a autorização de
   * uso do A1 sem alguém acionando. Indisponível onde não há gateway da SEFAZ —
   * em dev o banco é o de produção, e ligar daqui faria o agendador de produção
   * coletar por uma decisão tomada num ambiente de teste.
   */
  app.put<{ Params: CnpjParams; Body: { enabled: boolean } }>(
    '/clients/:cnpj/dfe/auto',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj'],
          properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
        },
        body: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);
      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);

      if (deps.dfe === undefined) {
        return reply.code(503).send({
          code: 'dfe_gateway_not_configured',
          message:
            'Coleta de DF-e indisponível neste ambiente, e com ela a coleta agendada. Em dev ' +
            'isso é esperado: o banco é o de produção, e dev não fala com a SEFAZ.',
        });
      }

      const orchestrator = await deps.orchestratorFor(scope);
      const estado = await setAutoSync(
        deps.pool,
        scope,
        request.body.enabled,
        context.user.userId,
        orchestrator,
      );
      return reply.code(200).send({ cnpj: scope.cnpj, auto_sync: estado });
    },
  );
}

function withoutTotal(row: Record<string, unknown>): Record<string, unknown> {
  const { total: _ignored, ...rest } = row;
  return rest;
}
