import { describe, it, expect } from 'vitest';
import {
  allocateTiers,
  assertValidSchedule,
  TierScheduleError,
  MAX_TIER_DISCOUNT_BPS,
  type PricingTier,
  type TierAllocationInput,
  type TierAllocation,
} from '../../src/billing/volume-tiers.js';

/** Escada semeada pela migration. Hipótese comercial, não benchmark. */
const tiers: PricingTier[] = [
  { fromClients: 1, discountBps: 0, label: 'Até 100 CNPJs' },
  { fromClients: 101, discountBps: 1500, label: '101 a 300 CNPJs' },
  { fromClients: 301, discountBps: 3000, label: '301 a 600 CNPJs' },
  { fromClients: 601, discountBps: 4000, label: '601 a 1.000 CNPJs' },
  { fromClients: 1001, discountBps: 5000, label: 'Acima de 1.000 CNPJs' },
];

const PRECO = {
  mei: 900,
  simples_hibrido: 2900,
  lucro_presumido: 4900,
  lucro_real: 8900,
} as const;

function unidade(
  regime: keyof typeof PRECO,
  quantity: number,
): TierAllocationInput {
  return { regime, unitCents: PRECO[regime], quantity };
}

/** Soma o líquido de todas as fatias — é o que a fatura cobra. */
function liquido(allocation: TierAllocation): number {
  let total = 0;
  for (const slices of allocation.byRegime.values()) {
    for (const slice of slices) {
      total += slice.netCents;
    }
  }
  return total;
}

function bruto(allocation: TierAllocation): number {
  let total = 0;
  for (const slices of allocation.byRegime.values()) {
    for (const slice of slices) {
      total += slice.grossCents;
    }
  }
  return total;
}

describe('allocateTiers — degressão por volume', () => {
  it('sem faixas não há desconto, e o líquido é o linear de sempre', () => {
    const resultado = allocateTiers([unidade('simples_hibrido', 500)], []);

    expect(resultado.totalDiscountCents).toBe(0);
    expect(resultado.effectiveDiscountBps).toBe(0);
    expect(resultado.byRegime.size).toBe(0);
  });

  it('carteira vazia não aloca nada', () => {
    const resultado = allocateTiers([unidade('mei', 0)], tiers);

    expect(resultado.totalDiscountCents).toBe(0);
    expect(liquido(resultado)).toBe(0);
  });

  it('carteira inteira dentro da primeira faixa não ganha desconto', () => {
    const resultado = allocateTiers([unidade('simples_hibrido', 100)], tiers);

    expect(resultado.totalDiscountCents).toBe(0);
    expect(liquido(resultado)).toBe(100 * 2900);
  });

  it('o CNPJ 101 é o primeiro a descontar, e desconta só ele', () => {
    const resultado = allocateTiers([unidade('simples_hibrido', 101)], tiers);

    // 100 × 2900 cheios + 1 × 2900 com 15%
    expect(resultado.totalDiscountCents).toBe(Math.round(2900 * 0.15));
    expect(liquido(resultado)).toBe(100 * 2900 + (2900 - Math.round(2900 * 0.15)));
  });

  /**
   * O caso do briefing. Serve de documentação viva: se a escada da migration
   * mudar, este número muda junto e alguém precisa decidir conscientemente.
   */
  it('1.200 CNPJs de Simples Híbrido: R$ 34.800 bruto viram R$ 23.780', () => {
    const resultado = allocateTiers([unidade('simples_hibrido', 1200)], tiers);

    expect(bruto(resultado)).toBe(3_480_000);
    expect(resultado.totalDiscountCents).toBe(1_102_000);
    expect(liquido(resultado)).toBe(2_378_000);
    expect(resultado.effectiveDiscountBps).toBe(3167);
  });

  it('aloca os CNPJs mais caros nas posições sem desconto', () => {
    // 100 lucro_real (R$ 89) + 100 mei (R$ 9). Os caros ocupam 1..100.
    const resultado = allocateTiers([unidade('mei', 100), unidade('lucro_real', 100)], tiers);

    const real = resultado.byRegime.get('lucro_real')!;
    const mei = resultado.byRegime.get('mei')!;

    expect(real).toHaveLength(1);
    expect(real[0]!.discountBps).toBe(0);
    expect(real[0]!.fromClients).toBe(1);

    // Os 100 MEI caem inteiros na segunda faixa (posições 101..200).
    expect(mei).toHaveLength(1);
    expect(mei[0]!.discountBps).toBe(1500);
  });

  it('um regime que atravessa fronteira vira duas fatias contíguas', () => {
    // 150 simples_hibrido sozinhos: 100 na faixa 1, 50 na faixa 2.
    const resultado = allocateTiers([unidade('simples_hibrido', 150)], tiers);
    const fatias = resultado.byRegime.get('simples_hibrido')!;

    expect(fatias).toHaveLength(2);
    expect(fatias[0]).toMatchObject({ fromClients: 1, quantity: 100, discountBps: 0 });
    expect(fatias[1]).toMatchObject({ fromClients: 101, quantity: 50, discountBps: 1500 });
  });

  it('as fatias somam a quantidade e o bruto do regime', () => {
    const unidades = [
      unidade('lucro_real', 120),
      unidade('simples_hibrido', 400),
      unidade('mei', 90),
    ];
    const resultado = allocateTiers(unidades, tiers);

    for (const unit of unidades) {
      const fatias = resultado.byRegime.get(unit.regime)!;
      const quantidade = fatias.reduce((soma, f) => soma + f.quantity, 0);
      const brutoRegime = fatias.reduce((soma, f) => soma + f.grossCents, 0);

      expect(quantidade).toBe(unit.quantity);
      expect(brutoRegime).toBe(unit.unitCents * unit.quantity);
    }
  });

  it('bruto menos desconto fecha com o líquido em toda fatia', () => {
    // Quantidade ímpar e desconto que não divide redondo, para pegar centavo perdido.
    const resultado = allocateTiers([unidade('simples_hibrido', 333)], tiers);

    for (const fatias of resultado.byRegime.values()) {
      for (const fatia of fatias) {
        expect(fatia.netCents).toBe(fatia.grossCents - fatia.discountCents);
        expect(Number.isInteger(fatia.discountCents)).toBe(true);
      }
    }
    expect(liquido(resultado)).toBe(bruto(resultado) - resultado.totalDiscountCents);
  });

  it('a ordem das unidades na entrada não muda o resultado', () => {
    const a = allocateTiers(
      [unidade('mei', 50), unidade('lucro_real', 200), unidade('simples_hibrido', 120)],
      tiers,
    );
    const b = allocateTiers(
      [unidade('simples_hibrido', 120), unidade('mei', 50), unidade('lucro_real', 200)],
      tiers,
    );

    expect(liquido(a)).toBe(liquido(b));
    expect(a.totalDiscountCents).toBe(b.totalDiscountCents);
    expect([...a.byRegime.get('mei')!]).toEqual([...b.byRegime.get('mei')!]);
  });
});

/**
 * Monotonicidade é a propriedade que justificou a escolha do modelo marginal
 * com alocação decrescente. Sem ela, acrescentar um CNPJ baixaria a fatura — e
 * o escritório descobriria. Por isso ela é testada, e não apenas argumentada.
 */
describe('allocateTiers — monotonicidade', () => {
  it('acrescentar um CNPJ do mesmo regime nunca baixa a fatura', () => {
    for (const regime of ['mei', 'simples_hibrido', 'lucro_real'] as const) {
      let anterior = 0;
      for (let n = 0; n <= 1500; n += 1) {
        const atual = liquido(allocateTiers([unidade(regime, n)], tiers));
        expect(atual).toBeGreaterThanOrEqual(anterior);
        anterior = atual;
      }
    }
  });

  /**
   * O contraexemplo do rateio proporcional, virado em teste: 100 lucro_real
   * mais um MEI. Com rateio o total cairia de R$ 8.900,00 para R$ 8.895,73.
   */
  it('acrescentar um MEI barato a uma carteira cara não baixa a fatura', () => {
    const so_real = liquido(allocateTiers([unidade('lucro_real', 100)], tiers));
    const com_mei = liquido(
      allocateTiers([unidade('lucro_real', 100), unidade('mei', 1)], tiers),
    );

    expect(com_mei).toBeGreaterThan(so_real);
  });

  it('carteira mista crescendo de um em um nunca encolhe de preço', () => {
    let anterior = 0;
    for (let i = 0; i <= 50; i += 1) {
      const atual = liquido(
        allocateTiers([unidade('lucro_real', 300 + i), unidade('mei', i)], tiers),
      );
      expect(atual).toBeGreaterThanOrEqual(anterior);
      anterior = atual;
    }
  });
});

describe('assertValidSchedule', () => {
  it('aceita a escada semeada', () => {
    expect(() => assertValidSchedule(tiers)).not.toThrow();
  });

  it('aceita escada vazia — é o modelo linear', () => {
    expect(() => assertValidSchedule([])).not.toThrow();
  });

  it('recusa escada que não começa em 1, porque sobrariam posições sem preço', () => {
    expect(() => assertValidSchedule([{ fromClients: 10, discountBps: 0 }])).toThrow(
      TierScheduleError,
    );
  });

  it('recusa duas faixas começando no mesmo ponto', () => {
    expect(() =>
      assertValidSchedule([
        { fromClients: 1, discountBps: 0 },
        { fromClients: 1, discountBps: 1000 },
      ]),
    ).toThrow(TierScheduleError);
  });

  it('recusa escada decrescente', () => {
    expect(() =>
      assertValidSchedule([
        { fromClients: 1, discountBps: 2000 },
        { fromClients: 101, discountBps: 1000 },
      ]),
    ).toThrow(/não-decrescente/);
  });

  it('recusa desconto acima de 50%, que quebraria a monotonicidade', () => {
    expect(() =>
      assertValidSchedule([
        { fromClients: 1, discountBps: 0 },
        { fromClients: 101, discountBps: MAX_TIER_DISCOUNT_BPS + 1 },
      ]),
    ).toThrow(/monotônico/);
  });

  it('recusa desconto negativo e início fracionário', () => {
    expect(() => assertValidSchedule([{ fromClients: 1, discountBps: -1 }])).toThrow(
      TierScheduleError,
    );
    expect(() => assertValidSchedule([{ fromClients: 1.5, discountBps: 0 }])).toThrow(
      TierScheduleError,
    );
  });
});
