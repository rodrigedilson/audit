import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { PostgresEventStoreRepository } from '../../infrastructure/persistence/postgres-event-store.repository.js';
import { EventReplayerService } from '../../esaa/core/event-store/event-replayer.service.js';
import { ProjectorService } from '../../esaa/core/projection/projector.service.js';
import { HashVerifierService } from '../../esaa/core/projection/hash-verifier.service.js';

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
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

      const projector = new ProjectorService();
      const roadmap = projector.project(events);
      const verification = new HashVerifierService(projector).verify(events, roadmap);

      return reply.code(200).send({
        ok: verification.valid,
        stored_hash: verification.storedHash,
        replayed_hash: verification.replayHash,
        last_event_seq: roadmap.last_event_seq,
      });
    },
  );
}

/**
 * O envelope guarda o actor como texto. Um UUID é usuário; os demais nomes são
 * agentes ou o orquestrador. Some quando o actor virar tipado, na Onda 2.
 */
function inferActorType(actor: string): 'user' | 'agent' | 'orchestrator' | 'system' {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor)) {
    return 'user';
  }
  return actor === 'tech-lead' || actor === 'closer' ? 'orchestrator' : 'agent';
}
