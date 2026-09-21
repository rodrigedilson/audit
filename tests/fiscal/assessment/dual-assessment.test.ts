import { describe, it, expect } from 'vitest';
import {
  project,
  totalDue,
  emptyRuleSet,
  type AssessmentDocument,
  type AssessmentItem,
  type AnyTax,
  type CreditRule,
  type RuleSet,
} from '../../../src/fiscal/assessment/dual-assessment.js';

const CHAVE_A = '35270812345678000195550010000000151234567895';
const CHAVE_B = '35270898765432000110550010000000201234567897';

function item(over: Partial<AssessmentItem> = {}): AssessmentItem {
  return {
    line: 1,
    code: 'SKU-1',
    ncm: '73181500',
    totalCents: 100_000,
    legacy: {
      icms: { cst: '00', baseCents: 100_000, rate: 18, amountCents: 18_000 },
      pis: { cst: '01', baseCents: 100_000, rate: 1.65, amountCents: 1_650 },
      cofins: { cst: '01', baseCents: 100_000, rate: 7.6, amountCents: 7_600 },
    },
    ...over,
  };
}

const comReforma = (over: Partial<AssessmentItem> = {}): AssessmentItem =>
  item({
    reform: {
      cst: '000',
      cclasstrib: '000001',
      cbs: { baseCents: 100_000, rate: 9.21, amountCents: 9_210 },
      ibs_uf: { baseCents: 100_000, rate: 0.1, amountCents: 100 },
    },
    ...over,
  });

const doc = (
  direction: 'inbound' | 'outbound',
  itens: AssessmentItem[],
  accessKey = CHAVE_A,
): AssessmentDocument => ({ accessKey, direction, items: itens });

const regras = (...pares: [AnyTax, number][]): RuleSet => ({
  creditRules: new Map<AnyTax, CreditRule>(
    pares.map(([tax, share]) => [tax, { tax, creditableShare: share, ruleId: `regra-${tax}` }]),
  ),
});

const base = { period: '2027-01', regime: 'lucro_real' as const, rules: emptyRuleSet() };

describe('project — débito e crédito potencial saem dos documentos', () => {
  it('saída gera débito', () => {
    const r = project({ ...base, documents: [doc('outbound', [item()])] });

    expect(r.legacy.icms.debitsCents).toBe(18_000);
    expect(r.legacy.icms.potentialCreditsCents).toBe(0);
  });

  it('entrada gera crédito potencial', () => {
    const r = project({ ...base, documents: [doc('inbound', [item()])] });

    expect(r.legacy.icms.debitsCents).toBe(0);
    expect(r.legacy.icms.potentialCreditsCents).toBe(18_000);
  });

  /** É a "Base Espelho": 100% dos documentos, sem amostragem e sem alíquota assumida. */
  it('soma todos os documentos e itens da competência', () => {
    const r = project({
      ...base,
      documents: [
        doc('outbound', [item(), item({ line: 2 })]),
        doc('inbound', [item()], CHAVE_B),
      ],
    });

    expect(r.documentsConsidered).toBe(2);
    expect(r.itemsConsidered).toBe(3);
    expect(r.legacy.icms.debitsCents).toBe(36_000);
    expect(r.legacy.icms.potentialCreditsCents).toBe(18_000);
  });

  it('soma os dois sistemas do mesmo item', () => {
    const r = project({ ...base, documents: [doc('outbound', [comReforma()])] });

    expect(r.legacy.icms.debitsCents).toBe(18_000);
    expect(r.reform.cbs.debitsCents).toBe(9_210);
    expect(r.reform.ibs_uf.debitsCents).toBe(100);
  });

  it('ignora tributo que o documento não destaca', () => {
    const r = project({
      ...base,
      documents: [doc('outbound', [item({ legacy: { icms: { baseCents: 1, rate: 1, amountCents: 5 } } })])],
    });

    expect(r.legacy.ipi.debitsCents).toBe(0);
    expect(r.legacy.icms.debitsCents).toBe(5);
  });
});

describe('project — recusa de calcular sem regra publicada', () => {
  /**
   * A decisão central: um número fiscal errado é pior do que um ausente. O
   * ausente o contador investiga; o errado ele entrega.
   */
  it('sem regra de creditamento, devido fica null com o motivo', () => {
    const r = project({ ...base, documents: [doc('outbound', [item()])] });

    expect(r.legacy.icms.debitsCents).toBe(18_000);
    expect(r.legacy.icms.creditableCents).toBeNull();
    expect(r.legacy.icms.dueCents).toBeNull();

    const motivo = r.notComputable.find((n) => n.subject === 'icms');
    expect(motivo?.reason).toBe('rule_not_published');
    expect(motivo?.message).toMatch(/não é determinável/);
  });

  it('tributo sem movimento não precisa de regra: devido é zero, não null', () => {
    const r = project({ ...base, documents: [doc('outbound', [item()])] });

    // O item não destaca IPI, então não há juízo de creditamento a fazer.
    expect(r.legacy.ipi.dueCents).toBe(0);
    expect(r.notComputable.some((n) => n.subject === 'ipi')).toBe(false);
  });

  it('com regra publicada, calcula o devido e registra a regra aplicada', () => {
    const r = project({
      ...base,
      rules: regras(['icms', 1]),
      documents: [doc('outbound', [item()]), doc('inbound', [item()], CHAVE_B)],
    });

    expect(r.legacy.icms.creditableCents).toBe(18_000);
    expect(r.legacy.icms.dueCents).toBe(0);
    expect(r.legacy.icms.ruleId).toBe('regra-icms');
  });

  it('aproveitamento parcial reduz o crédito, não o débito', () => {
    const r = project({
      ...base,
      rules: regras(['icms', 0.5]),
      documents: [doc('outbound', [item()]), doc('inbound', [item()], CHAVE_B)],
    });

    expect(r.legacy.icms.debitsCents).toBe(18_000);
    expect(r.legacy.icms.potentialCreditsCents).toBe(18_000);
    expect(r.legacy.icms.creditableCents).toBe(9_000);
    expect(r.legacy.icms.dueCents).toBe(9_000);
  });

  /** Fração de centavo em milhares de itens aparece no total da guia. */
  it('arredonda o crédito aproveitável em centavos inteiros', () => {
    const r = project({
      ...base,
      rules: regras(['icms', 1 / 3]),
      documents: [doc('inbound', [item({ legacy: { icms: { baseCents: 0, rate: 0, amountCents: 100 } } })])],
    });

    expect(r.legacy.icms.creditableCents).toBe(33);
    expect(Number.isInteger(r.legacy.icms.creditableCents)).toBe(true);
  });

  it('regra de um tributo não determina o outro', () => {
    const r = project({
      ...base,
      rules: regras(['icms', 1]),
      documents: [doc('outbound', [item()])],
    });

    // Só saída: não há crédito a abater, então o devido é o débito cheio.
    expect(r.legacy.icms.dueCents).toBe(18_000);
    expect(r.legacy.pis.dueCents).toBeNull();
    expect(r.notComputable.map((n) => n.subject)).toContain('pis');
    expect(r.notComputable.map((n) => n.subject)).not.toContain('icms');
  });
});

describe('project — prontidão para a reforma', () => {
  it('conta os itens que já trazem o grupo IBS/CBS', () => {
    const r = project({
      ...base,
      documents: [doc('outbound', [comReforma(), item({ line: 2 })])],
    });

    expect(r.coverage).toEqual({ itemsWithReformGroup: 1, itemsTotal: 2 });
  });

  it('item sem grupo UB entra em notComputable identificando a linha', () => {
    const r = project({ ...base, documents: [doc('outbound', [item()])] });

    const motivo = r.notComputable.find((n) => n.reason === 'missing_reform_group');
    expect(motivo?.subject).toBe(`${CHAVE_A}#1`);
    expect(motivo?.message).toMatch(/não pode ser conferido contra o documento/);
  });

  it('carteira toda com grupo UB não gera motivo de item', () => {
    const r = project({ ...base, documents: [doc('outbound', [comReforma()])] });

    expect(r.notComputable.some((n) => n.reason === 'missing_reform_group')).toBe(false);
  });
});

describe('project — memória de cálculo', () => {
  it('uma linha por item e por tributo, com origem', () => {
    const r = project({ ...base, documents: [doc('outbound', [comReforma()])] });

    // icms, pis, cofins, cbs, ibs_uf
    expect(r.trace).toHaveLength(5);
    expect(r.trace.every((l) => l.origin === 'documento')).toBe(true);
  });

  it('cada linha carrega base, alíquota, valor e a chave do documento', () => {
    const r = project({ ...base, documents: [doc('outbound', [item()])] });
    const icms = r.trace.find((l) => l.tax === 'icms');

    expect(icms).toMatchObject({
      accessKey: CHAVE_A,
      line: 1,
      itemCode: 'SKU-1',
      ncm: '73181500',
      cst: '00',
      baseCents: 100_000,
      rate: 18,
      amountCents: 18_000,
      direction: 'outbound',
    });
  });

  /**
   * A memória entra no Book, que carrega o hash da projeção. Ordem instável
   * faria o mesmo conjunto de documentos render um Book diferente.
   */
  it('a ordem é estável e independe da ordem de entrada', () => {
    const a = project({
      ...base,
      documents: [doc('outbound', [item()]), doc('inbound', [item()], CHAVE_B)],
    });
    const b = project({
      ...base,
      documents: [doc('inbound', [item()], CHAVE_B), doc('outbound', [item()])],
    });

    expect(a.trace).toEqual(b.trace);
  });

  it('ordena por chave, depois linha, depois tributo', () => {
    const r = project({
      ...base,
      documents: [doc('outbound', [item({ line: 2 }), item({ line: 1 })])],
    });

    expect(r.trace.map((l) => l.line)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(r.trace.slice(0, 3).map((l) => l.tax)).toEqual(['cofins', 'icms', 'pis']);
  });
});

describe('totalDue', () => {
  it('soma os devidos quando todos são determináveis', () => {
    const r = project({
      ...base,
      rules: regras(['icms', 1], ['pis', 1], ['cofins', 1]),
      documents: [doc('outbound', [item()])],
    });

    // 18000 + 1650 + 7600, sem crédito de entrada
    expect(totalDue(r)).toBe(27_250);
  });

  /** Somar ignorando o indeterminável daria um total que parece completo e não é. */
  it('devolve null quando algum tributo não é determinável', () => {
    const r = project({
      ...base,
      rules: regras(['icms', 1]),
      documents: [doc('outbound', [item()])],
    });

    expect(totalDue(r)).toBeNull();
  });

  it('competência sem documento devolve zero, não null', () => {
    const r = project({ ...base, documents: [] });

    expect(totalDue(r)).toBe(0);
    expect(r.notComputable).toEqual([]);
  });
});

describe('project — determinismo', () => {
  it('a mesma entrada produz o mesmo resultado', () => {
    const entrada = {
      ...base,
      rules: regras(['icms', 0.5]),
      documents: [doc('outbound', [comReforma()]), doc('inbound', [item()], CHAVE_B)],
    };

    expect(project(entrada)).toEqual(project(entrada));
  });
});
