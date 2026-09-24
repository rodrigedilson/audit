import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { PlanFeatures } from '../../billing/plan-features.js';

/**
 * Rota → feature do plano que ela exige. É um mapa só, e não uma chamada em
 * cada rota, pelo mesmo motivo da autenticação global: o que está aqui é o
 * inventário do que é vendido por plano, e dá para conferi-lo de uma vez contra
 * a tabela de preço.
 *
 * Todo método da rota é fechado: ler a apuração de um CNPJ cujo plano não a
 * inclui é usá-la. O que não está aqui (documentos, competências, Book, eventos,
 * certificado) é a base de todos os planos.
 */
export const FEATURE_POR_ROTA: Readonly<Record<string, string>> = {
  '/clients/:cnpj/items': 'saude_cadastro',
  '/clients/:cnpj/items/health': 'saude_cadastro',
  '/clients/:cnpj/items/:item_id/classification': 'saude_cadastro',

  '/clients/:cnpj/sync': 'coleta_dfe',
  '/clients/:cnpj/dfe': 'coleta_dfe',

  '/clients/:cnpj/simulations': 'simulador_opcao',

  '/clients/:cnpj/assessments/:period': 'apuracao_dual',
  '/clients/:cnpj/assessments/:period/trace': 'apuracao_dual',
  '/clients/:cnpj/assessments/:period/adjustments': 'apuracao_dual',
  '/clients/:cnpj/assessments/:period/confirm': 'apuracao_dual',

  '/clients/:cnpj/fisco-assessments/:period': 'contra_apuracao',

  '/clients/:cnpj/bank-statements': 'credito_em_risco',
  '/clients/:cnpj/payment-matches': 'credito_em_risco',
  '/clients/:cnpj/credits/at-risk': 'credito_em_risco',

  '/clients/:cnpj/sped': 'dossie_saldo_credor',
  '/clients/:cnpj/credit-dossier/:period': 'dossie_saldo_credor',

  '/clients/:cnpj/efd-icms-ipi': 'sped_completo',
  '/clients/:cnpj/icms-ipi-reconciliation/:period': 'sped_completo',
};

/** Rotas do escritório inteiro: abertas se algum CNPJ da carteira tiver a feature. */
export const FEATURE_POR_ROTA_DA_CARTEIRA: Readonly<Record<string, string>> = {
  '/deadlines': 'calendario',
};

const PREFIXO = '/v1';

/**
 * Hook que recusa, antes do handler, a rota cuja feature o plano do CNPJ não
 * inclui. Roda depois da validação: o CNPJ já passou pelo padrão da rota.
 *
 * CNPJ que não é da carteira passa direto, para a rota responder o 404 dela —
 * decidir aqui daria 403 para CNPJ de outro escritório, e o 403 confirmaria que
 * ele existe (ver `TenantResolver.scopeFor`).
 */
export function registerPlanGate(app: FastifyInstance, pool: Pool, features: PlanFeatures): void {
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const rota = (request.routeOptions.url ?? '').replace(PREFIXO, '');
    const tenant = request.tenant as FastifyRequest['tenant'] | undefined;
    if (tenant === undefined) return;

    const feature = FEATURE_POR_ROTA[rota];
    if (feature !== undefined) {
      const cnpj = (request.params as { cnpj?: string }).cnpj;
      if (cnpj === undefined) return;
      const { rows } = await pool.query<{ regime: string }>(
        'select regime from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
        [tenant.tenantId, cnpj],
      );
      const regime = rows[0]?.regime;
      if (regime === undefined) return;
      await features.exigir(regime, feature);
      return;
    }

    const daCarteira = FEATURE_POR_ROTA_DA_CARTEIRA[rota];
    if (daCarteira !== undefined) {
      const { rows } = await pool.query<{ regime: string }>(
        'select distinct regime from clients where tenant_id = $1::uuid',
        [tenant.tenantId],
      );
      // Carteira vazia não tem prazo nenhum: a rota responde a lista vazia.
      if (rows.length === 0) return;
      for (const { regime } of rows) {
        if (await features.inclui(regime, daCarteira)) return;
      }
      await features.exigir(rows[0]!.regime, daCarteira);
    }
  });
}

