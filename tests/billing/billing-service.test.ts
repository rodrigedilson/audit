import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  BillingService,
  BillingSettingsMissingError,
} from '../../src/billing/billing.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

/** Pool dublado, por ordem de chamada. */
function poolDeFila(...resultados: Record<string, unknown>[][]): Pool {
  const fila = [...resultados];
  return {
    query: async () => ({ rows: fila.shift() ?? [] }),
  } as unknown as Pool;
}

const PLANOS = [{ regime: 'simples_nacional', monthly_cents: 900 }];

describe('BillingService — parâmetros de cobrança', () => {
  it('o mínimo vem de billing_settings', async () => {
    const service = new BillingService(poolDeFila(PLANOS, [{ minimum_cents: 20000 }]));

    expect((await service.pricingRules()).minimumCents).toBe(20000);
  });

  it('sem a linha de billing_settings, falha em vez de inventar o mínimo', async () => {
    const service = new BillingService(poolDeFila(PLANOS, []));

    await expect(service.pricingRules()).rejects.toBeInstanceOf(BillingSettingsMissingError);
  });

  it('sem a linha de billing_settings, não abre trial com prazo inventado', async () => {
    const service = new BillingService(poolDeFila([]));

    await expect(service.startTrial(TENANT)).rejects.toBeInstanceOf(BillingSettingsMissingError);
  });

  it('a mensagem aponta o doctor', () => {
    expect(new BillingSettingsMissingError().message).toMatch(/npm run doctor/);
  });
});
