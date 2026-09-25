import type { Pool } from 'pg';

/**
 * O que cada plano inclui, lido de `plans.features`.
 *
 * O plano é por regime do CNPJ (ver `billing.sql`), e a tabela de preço promete
 * o que cada um inclui. Até aqui só a tela respeitava a promessa: qualquer
 * cliente HTTP usava a apuração dual num CNPJ de MEI. A rota passa a recusar o
 * que o plano do CNPJ não inclui, com 403 e os planos que incluem.
 */

/** Recurso fora do plano do CNPJ. 403 `feature_not_in_plan`. */
export class FeatureNotInPlanError extends Error {
  constructor(
    readonly feature: string,
    readonly regime: string,
    readonly plansWithFeature: readonly string[],
  ) {
    super(
      `O recurso '${feature}' não está incluído no plano ${regime}. ` +
        (plansWithFeature.length === 0
          ? 'Nenhum plano o inclui hoje.'
          : `Está nos planos: ${plansWithFeature.join(', ')}.`),
    );
    this.name = 'FeatureNotInPlanError';
  }
}

/**
 * Cache curto no processo: o plano muda por migration, não por requisição, e
 * ler `plans` em toda chamada de rota fechada seria uma ida ao banco a mais sem
 * ganho. Um minuto é o atraso máximo para uma mudança de plano valer.
 */
const VALIDADE_MS = 60_000;

export class PlanFeatures {
  private cache: { ate: number; porRegime: Map<string, ReadonlySet<string>> } | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async porRegime(): Promise<Map<string, ReadonlySet<string>>> {
    if (this.cache !== undefined && this.cache.ate > this.now()) {
      return this.cache.porRegime;
    }
    const { rows } = await this.pool.query<{ regime: string; features: string[] }>(
      'select regime, features from plans',
    );
    const porRegime = new Map(rows.map((r) => [r.regime, new Set(r.features) as ReadonlySet<string>]));
    this.cache = { ate: this.now() + VALIDADE_MS, porRegime };
    return porRegime;
  }

  async inclui(regime: string, feature: string): Promise<boolean> {
    return (await this.porRegime()).get(regime)?.has(feature) ?? false;
  }

  /** Lança `FeatureNotInPlanError` quando o plano do regime não inclui a feature. */
  async exigir(regime: string, feature: string): Promise<void> {
    const planos = await this.porRegime();
    if (planos.get(regime)?.has(feature) === true) return;
    const comFeature = [...planos.entries()]
      .filter(([, features]) => features.has(feature))
      .map(([r]) => r)
      .sort();
    throw new FeatureNotInPlanError(feature, regime, comFeature);
  }
}
