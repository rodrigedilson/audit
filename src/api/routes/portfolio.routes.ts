import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface ListQuery {
  page?: number;
  page_size?: number;
  regime?: string;
  status?: string;
}

/**
 * Superfície de leitura da carteira. As escritas (`POST /clients`,
 * `POST /clients/{cnpj}/periods`) ficam para a Onda 2, junto do vocabulário
 * fiscal: `client.enrolled` e `period.opened` são eventos, e gravar essas
 * tabelas direto agora criaria estado fora do event log — exatamente o que o
 * produto vende que não acontece.
 */
export async function registerPortfolioRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    '/clients',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            regime: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.tenant;
      const page = request.query.page ?? 1;
      const pageSize = request.query.page_size ?? 50;

      const { rows } = await deps.pool.query<{
        cnpj: string;
        legal_name: string;
        regime: string;
        period: string | null;
        state: string | null;
        documents: string;
        total: string;
      }>(
        `with carteira as (
           select c.cnpj, c.legal_name, c.regime,
                  p.period, p.state,
                  (select count(*) from events e
                    where e.tenant_id = c.tenant_id and e.cnpj = c.cnpj
                      and e.action = 'doc.received') as documents
             from clients c
             left join lateral (
               select period, state from periods
                where tenant_id = c.tenant_id and cnpj = c.cnpj
                order by period desc limit 1
             ) p on true
            where c.tenant_id = $1::uuid
              and ($2::text is null or c.regime::text = $2::text)
              and ($3::text is null or c.status = $3::text)
         )
         select *, count(*) over () as total
           from carteira
          order by legal_name
          limit $4 offset $5`,
        [tenantId, request.query.regime ?? null, request.query.status ?? null, pageSize, (page - 1) * pageSize],
      );

      return reply.code(200).send({
        items: rows.map((row) => ({
          cnpj: row.cnpj,
          legal_name: row.legal_name,
          regime: row.regime,
          period: row.period,
          state: row.state,
          documents: Number(row.documents),
          // Zerados enquanto os contexts que os produzem não existem. Ficam no
          // payload porque o contrato os declara e o frontend já os consome.
          open_issues: 0,
          credit_at_risk_brl: 0,
          next_deadline: null,
        })),
        page,
        total: Number(rows[0]?.total ?? 0),
      });
    },
  );

  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const { rows } = await deps.pool.query(
        `select c.cnpj, c.legal_name, c.trade_name, c.regime, c.uf,
                c.municipality_ibge, c.cnae_primary, c.status, c.created_at,
                exists (
                  select 1 from events e
                   where e.tenant_id = c.tenant_id and e.cnpj = c.cnpj
                     and e.action = 'certificate.stored'
                ) as has_certificate
           from clients c
          where c.tenant_id = $1::uuid and c.cnpj = $2::char(14)`,
        [scope.tenantId, scope.cnpj],
      );

      const client = rows[0];
      if (!client) {
        throw new NotFoundError(`CNPJ ${scope.cnpj} não encontrado nesta carteira.`);
      }

      return reply.code(200).send(client);
    },
  );

  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/periods',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const { rows } = await deps.pool.query(
        `select period, state, projection_hash, confirmed_at, confirmed_by
           from periods
          where tenant_id = $1::uuid and cnpj = $2::char(14)
          order by period desc`,
        [scope.tenantId, scope.cnpj],
      );

      return reply.code(200).send(rows);
    },
  );
}
