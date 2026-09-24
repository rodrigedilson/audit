import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { ForbiddenError, NotFoundError } from '../auth/tenant-resolver.js';
import { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import { syncPortfolioReadModel } from '../../fiscal/portfolio/portfolio-read-model.js';
import { PERIOD_STATES, REGIMES } from '../../fiscal/shared/fiscal-vocabulary.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { PADRAO_DE_CNPJ, exigirCnpjNaRota } from './cnpj-param.js';

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface ListQuery {
  page?: number;
  page_size?: number;
  regime?: string;
  status?: string;
  state?: string;
}

/** Status do CNPJ na carteira. É a base da cobrança: só `active` é faturado. */
const CLIENT_STATUSES = ['active', 'inactive'] as const;

/**
 * Carteira do escritório: leitura e escrita.
 *
 * Toda escrita é uma **intenção** que passa pelo orquestrador e pelas 7 camadas;
 * as tabelas `clients` e `periods` são read model sincronizado depois do evento.
 * Nenhuma rota grava estado que o event log não explique.
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
            // Enumerados de propósito. Um valor fora da lista antes devolvia
            // carteira vazia com `200`, indistinguível de "nenhum CNPJ
            // cadastrado" — um filtro errado parecia um escritório vazio.
            regime: { type: 'string', enum: [...REGIMES] },
            status: { type: 'string', enum: [...CLIENT_STATUSES] },
            state: { type: 'string', enum: [...PERIOD_STATES] },
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
        status: string;
        documents: string;
        open_issues: string;
        next_deadline: string | null;
        total: string;
      }>(
        `with carteira as (
           select c.cnpj, c.legal_name, c.regime, c.status,
                  p.period, p.state,
                  (select count(*) from events e
                    where e.tenant_id = c.tenant_id and e.cnpj = c.cnpj
                      and e.action = 'doc.received') as documents,
                  -- Itens com a classificação vigente fora de 'ok'. É o número
                  -- que a tela de saúde do cadastro detalha.
                  (select count(*) from (
                     select distinct on (ic.item_id) ic.health
                       from item_classifications ic
                      where ic.tenant_id = c.tenant_id and ic.cnpj = c.cnpj
                      order by ic.item_id, ic.effective_from desc
                   ) vigente where vigente.health is distinct from 'ok') as open_issues,
                  d.due_date as next_deadline
             from clients c
             left join lateral (
               select period, state from periods
                where tenant_id = c.tenant_id and cnpj = c.cnpj
                order by period desc limit 1
             ) p on true
             left join lateral (
               select due_date from deadlines
                where tenant_id = c.tenant_id and cnpj = c.cnpj and state = 'pending'
                order by due_date limit 1
             ) d on true
            where c.tenant_id = $1::uuid
              and ($2::text is null or c.regime::text = $2::text)
              and ($3::text is null or c.status = $3::text)
         )
         select *, count(*) over () as total
           from carteira
           -- O estado filtra a competência corrente, e é o filtro da tela.
           -- Fica fora do where de cima porque p.state vem do lateral: um CNPJ
           -- sem competência aberta tem estado nulo e não casa com nada.
          where ($6::text is null or state::text = $6::text)
          order by legal_name
          limit $4 offset $5`,
        [
          tenantId,
          request.query.regime ?? null,
          request.query.status ?? null,
          pageSize,
          (page - 1) * pageSize,
          request.query.state ?? null,
        ],
      );

      return reply.code(200).send({
        items: rows.map((row) => ({
          cnpj: row.cnpj,
          legal_name: row.legal_name,
          regime: row.regime,
          status: row.status,
          period: row.period,
          state: row.state,
          documents: Number(row.documents),
          open_issues: Number(row.open_issues),
          /**
           * `null`, e não `0`.
           *
           * O estado do crédito é derivado na leitura (ver `credit-risk.ts`), e
           * derivá-lo para cada cliente da página custaria uma classificação por
           * linha. Repetir a regra em SQL só para esta listagem daria dois
           * números para a mesma pergunta, que divergiriam no primeiro ajuste.
           *
           * `0` diria "este cliente não tem crédito em risco", que é uma
           * afirmação. `null` diz "não calculado aqui" — e o número existe em
           * `GET /clients/{cnpj}/credits/at-risk`.
           */
          credit_at_risk_brl: null,
          next_deadline: row.next_deadline === null ? null : String(row.next_deadline).slice(0, 10),
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
                -- Do cofre, e não do log: o log é append-only, então
                -- "existe certificate.stored" continua verdadeiro depois de
                -- remover o certificado. O cabeçalho do cliente diria que há
                -- certificado guardado quando não há, e a coleta de DF-e
                -- falharia sem ninguém entender por quê.
                exists (
                  select 1 from certificates cert
                   where cert.tenant_id = c.tenant_id and cert.cnpj = c.cnpj
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

  /**
   * Cadastro de empresa. Emite `client.enrolled`.
   *
   * Só `owner`: incluir CNPJ na carteira muda a fatura do escritório, porque o
   * preço é por CNPJ ativo.
   */
  app.post<{ Body: ClientCreateBody }>(
    '/clients',
    {
      schema: {
        body: {
          type: 'object',
          required: ['cnpj', 'legal_name', 'regime'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            legal_name: { type: 'string', minLength: 1 },
            trade_name: { type: 'string' },
            regime: { type: 'string', enum: [...REGIMES] },
            uf: { type: 'string', minLength: 2, maxLength: 2 },
            municipality_ibge: { type: 'string', pattern: '^[0-9]{7}$' },
            cnae_primary: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);

      // Com o alfanumérico em vigor, 14 posições já não distinguem um CNPJ de
      // um pedaço de texto: `RAZAOSOCIALLT` casa com o padrão da rota. O dígito
      // verificador é o que sustenta a ampliação, e este é o ponto de entrada.
      const cnpj = exigirCnpjNaRota(request.body.cnpj, 'Cadastro de empresa');
      const scope = EventScope.create(context.tenantId, cnpj);

      // Idempotência de cadastro: o event log aceitaria um segundo
      // `client.enrolled`, mas cobrar duas vezes pelo mesmo CNPJ não é
      // aceitável, e a projeção ficaria com dois cadastros para o mesmo par.
      const orchestrator = await deps.orchestratorFor(scope);
      const existing = await orchestrator.getProjection();
      if (existing.client) {
        throw new ForbiddenError(`CNPJ ${scope.cnpj} já está cadastrado nesta carteira.`);
      }

      const result = await orchestrator.processIntention({
        action: 'client.enrolled',
        task_id: scope.cnpj,
        actor: context.user.userId,
        payload: { ...request.body },
      });

      if (!result.accepted) {
        throw new ValidationError(
          result.layer ?? 3,
          'schema_violation',
          result.rejectionReason ?? 'Cadastro rejeitado pelo pipeline.',
        );
      }

      await syncPortfolioReadModel(deps.pool, result.projection!);

      return reply.code(201).send(writeResult(result));
    },
  );

  /** Atualiza regime ou dados cadastrais. Emite `client.updated`. */
  app.patch<{ Params: CnpjParams; Body: ClientUpdateBody }>(
    '/clients/:cnpj',
    {
      schema: {
        params: CNPJ_PARAM,
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            trade_name: { type: 'string' },
            regime: { type: 'string', enum: [...REGIMES] },
            regime_effective_from: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
            status: { type: 'string', enum: [...CLIENT_STATUSES] },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const orchestrator = await deps.orchestratorFor(scope);

      const result = await orchestrator.processIntention({
        action: 'client.updated',
        task_id: scope.cnpj,
        actor: context.user.userId,
        payload: { ...request.body },
      });

      if (!result.accepted) {
        throw new ValidationError(
          result.layer ?? 3,
          'schema_violation',
          result.rejectionReason ?? 'Atualização rejeitada pelo pipeline.',
        );
      }

      await syncPortfolioReadModel(deps.pool, result.projection!);

      return reply.code(200).send(writeResult(result));
    },
  );

  /** Abre competência. Emite `period.opened`. `viewer` não abre período. */
  app.post<{ Params: CnpjParams; Body: { period: string } }>(
    '/clients/:cnpj/periods',
    {
      schema: {
        params: CNPJ_PARAM,
        body: {
          type: 'object',
          required: ['period'],
          properties: {
            period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const orchestrator = await deps.orchestratorFor(scope);
      const { period } = request.body;

      const result = await orchestrator.processIntention({
        action: 'period.opened',
        task_id: period,
        actor: context.user.userId,
        payload: { period },
        period,
      });

      if (!result.accepted) {
        // A camada 4 barra reabertura de competência já existente, e a 6 barra
        // competência confirmada. Os dois casos chegam aqui com a camada certa.
        throw new ValidationError(
          result.layer ?? 4,
          'invalid_transition',
          result.rejectionReason ?? 'Abertura rejeitada pelo pipeline.',
        );
      }

      await syncPortfolioReadModel(deps.pool, result.projection!);

      return reply.code(201).send(writeResult(result));
    },
  );
}

interface ClientCreateBody {
  cnpj: string;
  legal_name: string;
  trade_name?: string;
  regime: string;
  uf?: string;
  municipality_ibge?: string;
  cnae_primary?: string;
}

interface ClientUpdateBody {
  trade_name?: string;
  regime?: string;
  regime_effective_from?: string;
  status?: 'active' | 'inactive';
}

/** Forma `WriteResult` do contrato: toda escrita devolve seq e hash. */
function writeResult(result: {
  event?: { event_id: string; event_seq: number; action: string };
  projection?: { projection_hash_sha256: string };
}): Record<string, unknown> {
  return {
    event_id: result.event!.event_id,
    event_seq: result.event!.event_seq,
    action: result.event!.action,
    projection_hash: result.projection!.projection_hash_sha256,
  };
}
