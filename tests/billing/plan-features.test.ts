import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { FeatureNotInPlanError, PlanFeatures } from '../../src/billing/plan-features.js';

const poolCom = (linhas: { regime: string; features: string[] }[]) => {
  const query = vi.fn().mockResolvedValue({ rows: linhas });
  return { pool: { query } as unknown as Pool, query };
};

describe('PlanFeatures', () => {
  const PLANOS = [
    { regime: 'mei', features: ['saude_cadastro'] },
    { regime: 'lucro_real', features: ['saude_cadastro', 'apuracao_dual'] },
    { regime: 'lucro_presumido', features: ['apuracao_dual'] },
  ];

  it('recusa com a feature, o regime e os planos que a incluem, em ordem', async () => {
    const { pool } = poolCom(PLANOS);

    const erro = await new PlanFeatures(pool).exigir('mei', 'apuracao_dual').catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(FeatureNotInPlanError);
    expect(erro).toMatchObject({ feature: 'apuracao_dual', regime: 'mei', plansWithFeature: ['lucro_presumido', 'lucro_real'] });
  });

  it('regime sem plano não inclui nada', async () => {
    const { pool } = poolCom(PLANOS);
    expect(await new PlanFeatures(pool).inclui('regime_novo', 'saude_cadastro')).toBe(false);
  });

  it('lê os planos uma vez por minuto, e não a cada requisição', async () => {
    const { pool, query } = poolCom(PLANOS);
    let agora = 0;
    const features = new PlanFeatures(pool, () => agora);

    await features.inclui('mei', 'saude_cadastro');
    agora = 59_999;
    await features.inclui('mei', 'saude_cadastro');
    expect(query).toHaveBeenCalledTimes(1);

    agora = 60_001;
    await features.inclui('mei', 'saude_cadastro');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
