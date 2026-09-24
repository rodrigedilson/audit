import { describe, it, expect } from 'vitest';
import type {
  EfdIcmsAnalytic,
  EfdIcmsAssessment,
  EfdIcmsDocument,
  EfdIcmsResult,
  EfdIpiAssessment,
} from '../../../src/fiscal/ingestion/efd-icms-ipi.parser.js';
import {
  reconcileIcmsIpi,
  summarizeEfdIcmsIpi,
  type IcmsIpiCheck,
} from '../../../src/fiscal/reconciliation/icms-ipi-checks.js';

/** E110 coerente: 500.000 de débito, 400.000 de crédito, 100.000 apurados. */
const E110_COERENTE: EfdIcmsAssessment = {
  totalDebitsCents: 500_000,
  documentDebitAdjustmentsCents: 0,
  adjustmentDebitsCents: 0,
  creditReversalsCents: 0,
  totalCreditsCents: 400_000,
  documentCreditAdjustmentsCents: 0,
  adjustmentCreditsCents: 0,
  debitReversalsCents: 0,
  previousCreditBalanceCents: 0,
  assessedBalanceCents: 100_000,
  deductionsCents: 0,
  icmsPayableCents: 100_000,
  carriedCreditBalanceCents: 0,
  extraAssessmentCents: 0,
};

const E520_COERENTE: EfdIpiAssessment = {
  previousCreditBalanceCents: 0,
  debitsCents: 70_000,
  creditsCents: 30_000,
  otherDebitsCents: 0,
  otherCreditsCents: 0,
  carriedCreditBalanceCents: 0,
  ipiPayableCents: 40_000,
};

const analitico = (icms: number): EfdIcmsAnalytic => ({
  cstIcms: '00',
  cfop: '1102',
  icmsRate: 18,
  operationCents: icms * 6,
  icmsBaseCents: icms * 6,
  icmsCents: icms,
  icmsStBaseCents: 0,
  icmsStCents: 0,
  reducedBaseCents: 0,
  ipiCents: 0,
});

const documento = (
  overrides: Partial<EfdIcmsDocument> & Pick<EfdIcmsDocument, 'operation'>,
): EfdIcmsDocument => ({
  line: 1,
  issuedBySelf: true,
  model: '55',
  situation: '00',
  accessKey: '35260112345678000195550010000000011234567893',
  documentNumber: '1',
  issuedAt: '2026-01-15',
  totalCents: 0,
  icmsBaseCents: 0,
  icmsCents: 0,
  icmsStBaseCents: 0,
  icmsStCents: 0,
  ipiCents: 0,
  items: [],
  analytics: [],
  ...overrides,
});

const efd = (overrides: Partial<EfdIcmsResult> = {}): EfdIcmsResult => ({
  header: {
    layoutVersion: '020',
    cnpj: '12345678000195',
    uf: 'SP',
    stateRegistration: '110042490114',
    period: '2026-01',
    companyName: 'EMPRESA DE TESTE LTDA',
    kind: 'original',
  },
  documents: [],
  icmsAssessment: E110_COERENTE,
  ipiAssessment: E520_COERENTE,
  rejected: [],
  counts: { '0000': 1, E110: 1, E520: 1 },
  ...overrides,
});

/** A conciliação recebe o resumo, não o arquivo — o adaptador entra no caminho. */
const conciliar = (overrides: Partial<EfdIcmsResult> = {}) =>
  reconcileIcmsIpi(summarizeEfdIcmsIpi(efd(overrides)));

const pegar = (resultado: { checks: IcmsIpiCheck[] }, id: string): IcmsIpiCheck => {
  const achado = resultado.checks.find((c) => c.checkId === id);
  if (achado === undefined) {
    throw new Error(`Conferência '${id}' não existe no resultado.`);
  }
  return achado;
};

describe('reconcileIcmsIpi — aritmética do E110', () => {
  it('passa quando o saldo apurado segue a expressão do guia', () => {
    const check = pegar(conciliar(), 'e110-saldo-apurado');

    expect(check.status).toBe('passed');
    expect(check.differenceCents).toBe(0);
    expect(check.notVerifiedReason).toBeNull();
  });

  it('acusa o saldo apurado que não fecha, com a diferença em centavos', () => {
    const resultado = conciliar(({ icmsAssessment: { ...E110_COERENTE, assessedBalanceCents: 120_000 } }),
    );
    const check = pegar(resultado, 'e110-saldo-apurado');

    expect(check.status).toBe('failed');
    expect(check.declaredCents).toBe(120_000);
    expect(check.expectedCents).toBe(100_000);
    expect(check.differenceCents).toBe(20_000);
    expect(check.issues[0]?.message).toMatch(/R\$/);
  });

  it('leva os ajustes do documento para dentro da expressão', () => {
    // VL_AJ_DEBITOS e VL_AJ_CREDITOS são campos 3 e 7, e ficaram de fora da
    // primeira versão do leitor. Sem eles a expressão erra em silêncio.
    const resultado = conciliar(({
        icmsAssessment: {
          ...E110_COERENTE,
          documentDebitAdjustmentsCents: 5_000,
          documentCreditAdjustmentsCents: 2_000,
          assessedBalanceCents: 103_000,
        },
      }),
    );

    expect(pegar(resultado, 'e110-saldo-apurado').status).toBe('passed');
  });

  it('zera o saldo apurado e transporta o crédito, somando as deduções', () => {
    // Expressão = 300.000 − 400.000 = −100.000; com 20.000 de deduções o saldo a
    // transportar é 120.000, não 100.000. É a parte contraintuitiva da regra.
    const resultado = conciliar(({
        icmsAssessment: {
          ...E110_COERENTE,
          totalDebitsCents: 300_000,
          assessedBalanceCents: 0,
          deductionsCents: 20_000,
          icmsPayableCents: 0,
          carriedCreditBalanceCents: 120_000,
        },
      }),
    );

    expect(pegar(resultado, 'e110-saldo-apurado').status).toBe('passed');
    expect(pegar(resultado, 'e110-saldo-credor-transportar').status).toBe('passed');
    expect(pegar(resultado, 'e110-icms-a-recolher').status).toBe('passed');
  });

  it('acusa o ICMS a recolher que ignora as deduções', () => {
    const resultado = conciliar(({
        icmsAssessment: {
          ...E110_COERENTE,
          deductionsCents: 30_000,
          icmsPayableCents: 100_000,
          carriedCreditBalanceCents: 0,
        },
      }),
    );
    const check = pegar(resultado, 'e110-icms-a-recolher');

    expect(check.status).toBe('failed');
    expect(check.expectedCents).toBe(70_000);
    expect(check.severity).toBe('critical');
  });
});

describe('reconcileIcmsIpi — aritmética do E520', () => {
  it('passa quando o saldo devedor do IPI fecha', () => {
    expect(pegar(conciliar(), 'e520-apuracao-ipi').status).toBe('passed');
  });

  it('acusa saldo lançado no campo errado', () => {
    // Expressão negativa em 10.000: o valor tem de ir para VL_SC_IPI, não para
    // VL_SD_IPI. Comparar o líquido faz a troca aparecer em vez de se cancelar.
    const resultado = conciliar(({
        ipiAssessment: {
          ...E520_COERENTE,
          debitsCents: 20_000,
          ipiPayableCents: 10_000,
        },
      }),
    );
    const check = pegar(resultado, 'e520-apuracao-ipi');

    expect(check.status).toBe('failed');
    expect(check.expectedCents).toBe(-10_000);
    expect(check.declaredCents).toBe(10_000);
  });
});

describe('reconcileIcmsIpi — ausência não é aprovação', () => {
  it('marca not_verified, e não passed, quando não há E110', () => {
    const resultado = conciliar(({ icmsAssessment: null }));

    for (const id of [
      'e110-saldo-apurado',
      'e110-icms-a-recolher',
      'e110-saldo-credor-transportar',
    ]) {
      const check = pegar(resultado, id);
      expect(check.status).toBe('not_verified');
      expect(check.declaredCents).toBeNull();
      expect(check.notVerifiedReason).toMatch(/não é o mesmo que apuração correta/);
    }
  });

  it('marca not_verified quando não há E520', () => {
    const check = pegar(conciliar(({ ipiAssessment: null })), 'e520-apuracao-ipi');

    expect(check.status).toBe('not_verified');
    expect(check.notVerifiedReason).not.toBeNull();
  });

  it('todo not_verified traz motivo, nunca vazio', () => {
    const resultado = conciliar(({ icmsAssessment: null, ipiAssessment: null }));

    for (const check of resultado.checks.filter((c) => c.status === 'not_verified')) {
      expect(check.notVerifiedReason).toBeTruthy();
    }
  });

  it('conta as conferências não verificadas no resumo', () => {
    const resultado = conciliar(({ icmsAssessment: null }));

    expect(resultado.notVerifiedCount).toBeGreaterThanOrEqual(3);
  });
});

describe('reconcileIcmsIpi — documentos contra o declarado', () => {
  it('acusa item que não bate com a consolidação do documento', () => {
    const doc = documento({
      operation: 'outbound',
      items: [
        {
          itemNumber: 1,
          code: 'P1',
          cfop: '5102',
          totalCents: 100_000,
          icms: { cst: '00', baseCents: 100_000, rate: 18, amountCents: 18_000 },
          ipi: { cst: '50', baseCents: 0, rate: 0, amountCents: 0 },
        },
      ],
      analytics: [analitico(20_000)],
    });

    const check = pegar(conciliar(({ documents: [doc] })), 'c170-vs-c190');

    expect(check.status).toBe('failed');
    expect(check.differenceCents).toBe(2_000);
    expect(check.issues[0]?.subject).toBe(doc.accessKey);
  });

  it('não acusa documento que vem só com consolidação, como a NF-e própria', () => {
    const doc = documento({ operation: 'outbound', analytics: [analitico(20_000)] });
    const check = pegar(conciliar(({ documents: [doc] })), 'c170-vs-c190');

    expect(check.status).toBe('not_verified');
  });

  it('confere as saídas contra o total de débitos', () => {
    const resultado = conciliar(({
        documents: [
          documento({ operation: 'outbound', analytics: [analitico(500_000)] }),
          documento({ operation: 'inbound', analytics: [analitico(400_000)] }),
        ],
        counts: { '0000': 1, C100: 2, C190: 2, E110: 1 },
      }),
    );

    expect(pegar(resultado, 'c190-vs-e110-debitos').status).toBe('passed');
    expect(pegar(resultado, 'c190-vs-e110-creditos').status).toBe('passed');
  });

  it('não compara quando há blocos que este leitor ainda não soma', () => {
    // Conta de energia (C500) e transporte (D100) também lançam ICMS. Comparar
    // só os C190 acusaria uma diferença que é limitação nossa.
    const resultado = conciliar(({
        documents: [documento({ operation: 'outbound', analytics: [analitico(10_000)] })],
        counts: { '0000': 1, C100: 1, C190: 1, D100: 3, E110: 1 },
      }),
    );
    const check = pegar(resultado, 'c190-vs-e110-debitos');

    expect(check.status).toBe('not_verified');
    expect(check.notVerifiedReason).toMatch(/D100/);
    expect(check.notVerifiedReason).toMatch(/limitação nossa/);
    expect(check.declaredCents).toBe(500_000);
  });

  it('acusa documento cancelado que mesmo assim declara ICMS', () => {
    const doc = documento({
      operation: 'outbound',
      situation: '02',
      analytics: [analitico(18_000)],
    });

    const resultado = conciliar(({ documents: [doc], counts: { '0000': 1, C100: 1, C190: 1, E110: 1 } }),
    );
    const check = pegar(resultado, 'documento-sem-imposto-com-valor');

    expect(check.status).toBe('failed');
    expect(check.severity).toBe('critical');
    expect(check.issues[0]?.message).toMatch(/COD_SIT 02/);
  });

  it('tira o documento cancelado da soma de débitos', () => {
    const resultado = conciliar(({
        documents: [
          documento({ operation: 'outbound', analytics: [analitico(500_000)] }),
          documento({ operation: 'outbound', situation: '02', analytics: [analitico(9_000)] }),
        ],
        counts: { '0000': 1, C100: 2, C190: 2, E110: 1 },
      }),
    );

    expect(pegar(resultado, 'c190-vs-e110-debitos').status).toBe('passed');
  });

  it('não diz passed quando não há documento cancelado para conferir', () => {
    const check = pegar(conciliar(), 'documento-sem-imposto-com-valor');

    expect(check.status).toBe('not_verified');
  });
});

describe('reconcileIcmsIpi — resumo', () => {
  it('soma as diferenças absolutas só das conferências que falharam', () => {
    const resultado = conciliar(({ icmsAssessment: { ...E110_COERENTE, assessedBalanceCents: 130_000 } }),
    );

    expect(resultado.failedCount).toBeGreaterThanOrEqual(1);
    expect(resultado.totalDifferenceCents).toBeGreaterThanOrEqual(30_000);
  });

  it('leva a competência do arquivo para o resultado', () => {
    expect(conciliar().period).toBe('2026-01');
  });
});

describe('summarizeEfdIcmsIpi', () => {
  it('identifica o documento pela chave de acesso', () => {
    const doc = documento({ operation: 'outbound' });

    expect(summarizeEfdIcmsIpi(efd({ documents: [doc] })).documents[0]?.subject).toBe(
      doc.accessKey,
    );
  });

  it('cai para modelo e número quando não há chave', () => {
    const doc = documento({ operation: 'outbound', accessKey: null, documentNumber: '77' });

    expect(summarizeEfdIcmsIpi(efd({ documents: [doc] })).documents[0]?.subject).toBe(
      'modelo 55 nº 77',
    );
  });

  it('distingue documento sem itens de documento com itens que somam zero', () => {
    const semItens = documento({ operation: 'outbound' });
    const comZero = documento({
      operation: 'outbound',
      items: [
        {
          itemNumber: 1,
          code: 'P1',
          cfop: '5102',
          totalCents: 1_000,
          icms: { cst: '40', baseCents: 0, rate: 0, amountCents: 0 },
          ipi: { cst: '53', baseCents: 0, rate: 0, amountCents: 0 },
        },
      ],
    });

    const resumo = summarizeEfdIcmsIpi(efd({ documents: [semItens, comZero] }));

    expect(resumo.documents[0]?.hasItems).toBe(false);
    expect(resumo.documents[1]?.hasItems).toBe(true);
    expect(resumo.documents[1]?.itemsIcmsCents).toBe(0);
  });
});
