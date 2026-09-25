import { describe, expect, it } from 'vitest';

import {
  CAPAG_GROUPS,
  computeCapag,
  type CapagFormula,
  type CapagTerm,
} from '../../../../src/fiscal/forensics/calc/capag.js';

const termo = (over: Partial<CapagTerm> & { variable: string; ordinal: number }): CapagTerm => ({
  description: `Descrição de ${over.variable}`,
  coefficient: 0.1,
  block: 'multiplied',
  substitutes: null,
  source: 'DIRF',
  ...over,
});

const formula = (over: Partial<CapagFormula> = {}): CapagFormula => ({
  group: 'pj_simples',
  incomeMultiplier: 5,
  terms: [
    termo({ variable: 'V1', ordinal: 1, coefficient: 0.03 }),
    termo({ variable: 'V2', ordinal: 2, coefficient: 0.09 }),
    termo({ variable: 'V3', ordinal: 3, coefficient: 0.7, block: 'added' }),
  ],
  legalBasis: 'Portaria PGFN 6.757/2022',
  sourceRef: 'conferido no teste',
  verified: true,
  ...over,
});

describe('computeCapag — a fórmula aplicada', () => {
  it('multiplica o bloco de rendimentos e soma o bloco direto', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 1_000_000, V2: 2_000_000, V3: 500_000 },
      totalDebtCents: 10_000_000,
    });

    // bloco = 1.000.000×0,03 + 2.000.000×0,09 = 30.000 + 180.000 = 210.000
    // capag = 210.000×5 + 500.000×0,7 = 1.050.000 + 350.000 = 1.400.000
    expect(r.capagCents).toBe(1_400_000);
    expect(r.unavailableReason).toBeNull();
  });

  it('a cobertura compara a capacidade com a dívida', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 1_000_000, V2: 2_000_000, V3: 500_000 },
      totalDebtCents: 2_800_000,
    });

    expect(r.coverage).toBeCloseTo(0.5, 10);
  });

  /**
   * Dívida zero não é cobertura infinita: é ausência de dívida a classificar.
   * A PGFN estima a capacidade mesmo de quem não deve.
   */
  it('dívida zero não produz cobertura', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 1_000_000, V2: 0, V3: 0 },
      totalDebtCents: 0,
    });

    expect(r.capagCents).toBeGreaterThan(0);
    expect(r.coverage).toBeNull();
  });

  it('a memória traz uma linha por variável, na ordem da portaria', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 1_000_000, V2: 2_000_000, V3: 500_000 },
      totalDebtCents: 1,
    });
    const variaveis = r.steps.map((s) => s.label).filter((l) => l.startsWith('V'));

    expect(variaveis[0]).toContain('V1');
    expect(variaveis[1]).toContain('V2');
    expect(variaveis[2]).toContain('V3');
  });

  it('todo passo em centavos é inteiro', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 333_333, V2: 777_777, V3: 111_111 },
      totalDebtCents: 1,
    });

    for (const passo of r.steps) {
      expect(Number.isInteger(passo.value), passo.label).toBe(true);
    }
  });

  it('a ordem dos termos não depende da ordem do array', () => {
    const invertida = formula({
      terms: [
        termo({ variable: 'V3', ordinal: 3, coefficient: 0.7, block: 'added' }),
        termo({ variable: 'V1', ordinal: 1, coefficient: 0.03 }),
        termo({ variable: 'V2', ordinal: 2, coefficient: 0.09 }),
      ],
    });
    const valores = { V1: 1_000_000, V2: 2_000_000, V3: 500_000 };

    expect(computeCapag({ formula: invertida, values: valores, totalDebtCents: 1 }).capagCents).toBe(
      computeCapag({ formula: formula(), values: valores, totalDebtCents: 1 }).capagCents,
    );
  });
});

describe('computeCapag — o que ele se recusa a afirmar', () => {
  /**
   * Zero se leria como "sem capacidade de pagamento", que é uma afirmação, e a
   * mais favorável ao cliente: exatamente a que a PGFN contesta.
   */
  it('sem fórmula devolve null e o motivo, nunca zero', () => {
    const r = computeCapag({ formula: null, values: {}, totalDebtCents: 1_000_000 });

    expect(r.capagCents).toBeNull();
    expect(r.capagCents).not.toBe(0);
    expect(r.unavailableReason).toContain('não está carregada');
  });

  it('fórmula não conferida em texto oficial não afirma capacidade', () => {
    const r = computeCapag({
      formula: formula({ verified: false, sourceRef: null }),
      values: { V1: 1, V2: 1, V3: 1 },
      totalDebtCents: 1,
    });

    expect(r.capagCents).toBeNull();
    expect(r.unavailableReason).toContain('não foi conferida');
  });

  /**
   * Variável ausente tratada como zero produziria capacidade menor que a real
   * — favorável ao cliente, e por isso a primeira coisa que a PGFN refaz.
   */
  it('variável ausente é nomeada, não tratada como zero', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 1_000_000 },
      totalDebtCents: 1,
    });

    expect(r.capagCents).toBeNull();
    expect(r.missingVariables).toEqual(['V2', 'V3']);
    expect(r.unavailableReason).toContain('V2, V3');
  });

  it('fórmula sem variáveis é recusada', () => {
    const r = computeCapag({ formula: formula({ terms: [] }), values: {}, totalDebtCents: 1 });

    expect(r.capagCents).toBeNull();
  });

  /**
   * A faixa A–D é o que decide o desconto que o cliente consegue. Inferi-la de
   * uma tabela não conferida produziria a classificação sem base.
   */
  it('a faixa nunca é inferida enquanto a tabela não existir', () => {
    const r = computeCapag({
      formula: formula(),
      values: { V1: 1_000_000, V2: 2_000_000, V3: 500_000 },
      totalDebtCents: 10_000_000,
    });

    expect(r.capagCents).not.toBeNull();
    expect(r.band).toBeNull();
  });
});

describe('CAPAG_GROUPS', () => {
  it('os quatro grupos da portaria estão declarados', () => {
    expect(CAPAG_GROUPS).toEqual(['pessoa_fisica', 'pj_nao_simples', 'pj_simples', 'mei']);
  });
});
