import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { ForbiddenError } from '../auth/tenant-resolver.js';
import {
  REGIMES_FORA,
  SimulationNotPossibleError,
  SimulationService,
  type SimulationRequest,
} from '../../fiscal/simulation/simulation.service.js';
import {
  NOT_MODELED,
  REGIMES_COMPARAVEIS,
  regimeComparavel,
} from '../../fiscal/simulation/regime-simulation.js';
import type { Regime } from '../../fiscal/shared/fiscal-vocabulary.js';

const PERIOD = '^[0-9]{4}-(0[1-9]|1[0-2])$';

const CNPJ_SCHEMA = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
} as const;

interface CnpjParams {
  cnpj: string;
}

/**
 * Simulador Integrado × Híbrido × Presumido — diferencial #8.
 *
 * Somente leitura sobre os dados da carteira: o serviço não recebe orquestrador
 * e nenhuma rota daqui grava evento fiscal. A simulação fica registrada em
 * tabela própria, porque a recomendação vai orientar a escolha de regime do
 * cliente para toda a transição e o escritório precisa poder mostrar depois com
 * que premissas aconselhou.
 */
export async function registerSimulationRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const simulation = new SimulationService(deps.pool);

  /**
   * Metodologia, sem CNPJ.
   *
   * Existe para a página pública: o que é comparado, o que **não** é modelado e
   * por quê. É a página que o simuleareforma tem e que o briefing cita como bom
   * exemplo — e é ela que impede o contador de tratar a saída como cálculo.
   */
  app.get('/simulations/methodology', async () => ({
    compares: REGIMES_COMPARAVEIS,
    excluded: Object.entries(REGIMES_FORA).map(([regime, reason]) => ({ regime, reason })),
    not_modeled: NOT_MODELED,
    reads_only: true,
    writes_fiscal_event: false,
    explains: [
      'Custo tributário direto e crédito repassável ao cliente PJ são números ' +
        'diferentes: no Simples integrado o cliente PJ não toma crédito, e para ' +
        'ganhar a concorrência o fornecedor precisa descontar o preço.',
      'O impacto da reforma aparece na necessidade de capital de giro, não na ' +
        'DRE: sob split payment o tributo sai do caixa na liquidação, e não no ' +
        'vencimento da guia.',
      'Quando o regime vencedor muda dentro da faixa de alíquotas explorada, a ' +
        'resposta é "depende" e não um vencedor — apontar um seria dar ' +
        'recomendação com cara de cálculo.',
    ],
  }));

  app.post<{ Params: CnpjParams; Body: SimulationRequest }>(
    '/clients/:cnpj/simulations',
    {
      schema: {
        params: CNPJ_SCHEMA,
        body: {
          type: 'object',
          required: ['scenario', 'base_from', 'base_to'],
          properties: {
            scenario: { type: 'string', enum: ['transition_2027_2028', 'full_2033'] },
            base_from: { type: 'string', pattern: PERIOD },
            base_to: { type: 'string', pattern: PERIOD },
            overrides: {
              type: 'object',
              properties: {
                ibs_cbs_rate: { type: 'number', minimum: 0, maximum: 100 },
                simples_effective_rate: { type: 'number', minimum: 0, maximum: 100 },
                creditable_share: { type: 'number', minimum: 0, maximum: 1 },
                presumed_profit_rate: { type: 'number', minimum: 0, maximum: 100 },
                tax_lag_days_current: { type: 'integer', minimum: 0, maximum: 365 },
                b2b_share: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      if (request.body.base_from > request.body.base_to) {
        throw new ValidationError(
          2,
          'schema_violation',
          `A competência inicial ${request.body.base_from} é posterior à final ` +
            `${request.body.base_to}.`,
        );
      }

      await assertRegimeComparavel(deps, scope.tenantId, scope.cnpj);

      try {
        const resultado = await simulation.run(
          scope,
          request.body,
          request.tenant.user.userId,
        );
        return reply.code(201).send(resultado);
      } catch (cause) {
        throw traduzir(cause);
      }
    },
  );

  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/simulations',
    { schema: { params: CNPJ_SCHEMA } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const simulacoes = await simulation.list(scope);

      return { simulations: simulacoes, total: simulacoes.length };
    },
  );

  /**
   * MEI e Lucro Real não entram na comparação, e a recusa explica o motivo em
   * vez de devolver uma tabela que não se aplica.
   */
  async function assertRegimeComparavel(
    dependencias: ApiDeps,
    tenantId: string,
    cnpj: string,
  ): Promise<void> {
    const { rows } = await dependencias.pool.query<{ regime: Regime }>(
      'select regime from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [tenantId, cnpj],
    );

    const regime = rows[0]?.regime;
    if (regime !== undefined && !regimeComparavel(regime)) {
      throw new ForbiddenError(
        REGIMES_FORA[regime] ??
          `O regime ${regime} não entra na comparação do simulador.`,
      );
    }
  }
}

function traduzir(cause: unknown): unknown {
  if (cause instanceof SimulationNotPossibleError) {
    return new ValidationError(4, 'invalid_transition', cause.message);
  }
  return cause;
}
