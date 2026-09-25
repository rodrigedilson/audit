import { describe, expect, it } from 'vitest';

import {
  accumulateIndex,
  cobreIntervalo,
  type IndexSeries,
} from '../../../../src/fiscal/forensics/calc/indices.js';
import {
  interest,
  restate,
  restateAndAccrue,
} from '../../../../src/fiscal/forensics/calc/monetary.js';

/** Série com variação constante de 1% ao mês, para a conta fechar à mão. */
const serie = (periods: readonly string[], variation = 0.01): IndexSeries => ({
  indexId: 'ipca',
  name: 'IPCA',
  source: 'IBGE',
  verified: true,
  points: periods.map((period) => ({ period, variation, level: null, sourceRef: 'conferido' })),
});

describe('accumulateIndex', () => {
  /**
   * O intervalo é meio-aberto: um valor de janeiro corrigido até março sofre a
   * variação de fevereiro e a de março. A de janeiro já está no valor.
   */
  it('acumula de from exclusivo até to inclusivo', () => {
    const a = accumulateIndex(serie(['2027-02', '2027-03']), '2027-01', '2027-03');

    expect(a.months).toBe(2);
    expect(a.factor).toBeCloseTo(1.01 * 1.01, 10);
  });

  it('mesma competência não sofre correção, e isso é resposta', () => {
    const a = accumulateIndex(serie([]), '2027-03', '2027-03');

    expect(a.factor).toBe(1);
    expect(a.months).toBe(0);
    expect(a.unavailableReason).toBeNull();
  });

  it('atravessa a virada de ano', () => {
    const a = accumulateIndex(serie(['2027-12', '2028-01']), '2027-11', '2028-01');

    expect(a.months).toBe(2);
    expect(a.factor).toBeCloseTo(1.0201, 10);
  });

  /**
   * Cobrir "quase todo" o intervalo não serve: um mês faltando no meio produz
   * fator menor que o real, e o laudo pediria menos do que é devido.
   */
  it('mês faltando no meio invalida o fator inteiro', () => {
    const a = accumulateIndex(serie(['2027-02', '2027-04']), '2027-01', '2027-04');

    expect(a.factor).toBeNull();
    expect(a.unavailableReason).toContain('2027-03');
  });

  it('série ausente devolve motivo, e não fator 1', () => {
    const a = accumulateIndex(null, '2027-01', '2027-06', 'igpm');

    expect(a.factor).toBeNull();
    expect(a.unavailableReason).toContain('igpm');
  });

  it('intervalo invertido é recusado', () => {
    expect(accumulateIndex(serie([]), '2027-06', '2027-01').factor).toBeNull();
  });

  it('carrega a fonte e se foi conferida, para ir impresso ao lado do número', () => {
    const a = accumulateIndex(serie(['2027-02']), '2027-01', '2027-02');

    expect(a.source).toBe('IBGE');
    expect(a.verified).toBe(true);
  });

  it('série não conferida ainda calcula, mas se declara não conferida', () => {
    const naoConferida = { ...serie(['2027-02']), verified: false };
    const a = accumulateIndex(naoConferida, '2027-01', '2027-02');

    expect(a.factor).toBeCloseTo(1.01, 10);
    expect(a.verified).toBe(false);
  });

  it('cobreIntervalo responde antes de pedir o cálculo', () => {
    expect(cobreIntervalo(serie(['2027-02']), '2027-01', '2027-02')).toBe(true);
    expect(cobreIntervalo(serie([]), '2027-01', '2027-02')).toBe(false);
  });
});

describe('restate — correção monetária', () => {
  it('corrige e separa a correção do principal', () => {
    const aplicado = accumulateIndex(serie(['2027-02', '2027-03']), '2027-01', '2027-03');
    const r = restate({ principalCents: 100_000, applied: aplicado });

    // 100.000 × 1,0201 = 102.010
    expect(r.restatedCents).toBe(102_010);
    expect(r.correctionCents).toBe(2_010);
  });

  /**
   * Arredondar a cada mês acumularia meio centavo por competência; numa
   * correção de anos a diferença aparece quando a outra parte refaz a conta.
   */
  it('arredonda uma vez, no fim', () => {
    const doze = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`);
    const aplicado = accumulateIndex(serie(doze), '2026-12', '2027-12');
    const r = restate({ principalCents: 100_000, applied: aplicado });

    expect(r.restatedCents).toBe(Math.round(100_000 * 1.01 ** 12));
  });

  it('índice indisponível devolve null e o motivo, nunca o valor original', () => {
    const aplicado = accumulateIndex(null, '2027-01', '2027-03', 'tr');
    const r = restate({ principalCents: 100_000, applied: aplicado });

    expect(r.restatedCents).toBeNull();
    expect(r.correctionCents).toBeNull();
    expect(r.unavailableReason).toContain('tr');
  });

  it('a memória nomeia índice, período, fonte e o número de competências', () => {
    const aplicado = accumulateIndex(serie(['2027-02']), '2027-01', '2027-02');
    const r = restate({ principalCents: 100_000, applied: aplicado });
    const texto = r.steps.map((s) => `${s.label} ${s.expression}`).join(' | ');

    expect(texto).toContain('ipca');
    expect(texto).toContain('2027-01');
    expect(texto).toContain('IBGE');
  });

  it('todo passo em centavos é inteiro', () => {
    const aplicado = accumulateIndex(serie(['2027-02', '2027-03']), '2027-01', '2027-03');
    const r = restate({ principalCents: 123_457, applied: aplicado });

    for (const passo of r.steps.filter((s) => s.unit === 'cents')) {
      expect(Number.isInteger(passo.value), passo.label).toBe(true);
    }
  });
});

describe('interest — juros', () => {
  it('simples aplica a taxa só sobre o capital inicial', () => {
    const j = interest({
      principalCents: 100_000,
      ratePerMonth: 0.01,
      months: 12,
      regime: 'simples',
    });

    // 100.000 × 0,01 × 12 = 12.000
    expect(j.interestCents).toBe(12_000);
    expect(j.totalCents).toBe(112_000);
  });

  it('composto aplica sobre o capital somado aos juros acumulados', () => {
    const j = interest({
      principalCents: 100_000,
      ratePerMonth: 0.01,
      months: 12,
      regime: 'composto',
    });

    expect(j.interestCents).toBe(Math.round(100_000 * (1.01 ** 12 - 1)));
    expect(j.interestCents).toBeGreaterThan(12_000);
  });

  /**
   * Qual regime se aplica não é escolha do perito: vem da decisão, do contrato
   * ou da lei. Por isso ele aparece na memória — laudo que não diz qual usou
   * está pedindo impugnação.
   */
  it('o regime usado aparece na memória de cálculo', () => {
    const simples = interest({ principalCents: 1, ratePerMonth: 0.01, months: 1, regime: 'simples' });
    const composto = interest({ principalCents: 1, ratePerMonth: 0.01, months: 1, regime: 'composto' });

    expect(simples.steps.some((s) => s.label.includes('simples'))).toBe(true);
    expect(composto.steps.some((s) => s.label.includes('composto'))).toBe(true);
  });

  it('prazo zero não gera juros', () => {
    expect(
      interest({ principalCents: 100_000, ratePerMonth: 0.01, months: 0, regime: 'composto' })
        .interestCents,
    ).toBe(0);
  });

  it('os dois regimes coincidem no primeiro mês e divergem depois', () => {
    const um = (regime: 'simples' | 'composto') =>
      interest({ principalCents: 100_000, ratePerMonth: 0.02, months: 1, regime }).interestCents;
    const dez = (regime: 'simples' | 'composto') =>
      interest({ principalCents: 100_000, ratePerMonth: 0.02, months: 10, regime }).interestCents;

    expect(um('simples')).toBe(um('composto'));
    expect(dez('composto')).toBeGreaterThan(dez('simples'));
  });
});

describe('restateAndAccrue — a ordem importa', () => {
  /**
   * Juros incidem sobre o valor CORRIGIDO. Aplicá-los antes renderia menos,
   * porque a base seria o valor histórico — erro que só aparece quando alguém
   * refaz a conta.
   */
  it('corrige primeiro e aplica juros sobre o corrigido', () => {
    const aplicado = accumulateIndex(serie(['2027-02', '2027-03']), '2027-01', '2027-03');
    const r = restateAndAccrue({
      principalCents: 100_000,
      applied: aplicado,
      ratePerMonth: 0.01,
      months: 2,
      regime: 'simples',
    });

    expect(r.restatedCents).toBe(102_010);
    // 102.010 × 0,01 × 2 = 2.040,2 → 2.040
    expect(r.interestCents).toBe(2_040);
    expect(r.totalCents).toBe(104_050);
  });

  it('juros sobre o corrigido rendem mais que sobre o histórico', () => {
    const aplicado = accumulateIndex(serie(['2027-02', '2027-03']), '2027-01', '2027-03');
    const correto = restateAndAccrue({
      principalCents: 100_000,
      applied: aplicado,
      ratePerMonth: 0.01,
      months: 2,
      regime: 'simples',
    });
    const invertido = interest({
      principalCents: 100_000,
      ratePerMonth: 0.01,
      months: 2,
      regime: 'simples',
    });

    expect(correto.interestCents!).toBeGreaterThan(invertido.interestCents);
  });

  /** O laudo discrimina os dois para o juízo poder acolher um sem o outro. */
  it('mantém correção e juros separados no resultado', () => {
    const aplicado = accumulateIndex(serie(['2027-02']), '2027-01', '2027-02');
    const r = restateAndAccrue({
      principalCents: 100_000,
      applied: aplicado,
      ratePerMonth: 0.01,
      months: 1,
      regime: 'simples',
    });

    expect(r.correctionCents).toBe(1_000);
    expect(r.interestCents).toBe(1_010);
    expect(r.totalCents).toBe(r.restatedCents! + r.interestCents!);
  });

  it('índice indisponível impede o conjunto, e diz por quê', () => {
    const r = restateAndAccrue({
      principalCents: 100_000,
      applied: accumulateIndex(null, '2027-01', '2027-03', 'selic'),
      ratePerMonth: 0.01,
      months: 2,
      regime: 'simples',
    });

    expect(r.totalCents).toBeNull();
    expect(r.interestCents).toBeNull();
    expect(r.unavailableReason).toContain('selic');
  });
});
