import { describe, it, expect } from 'vitest';
import {
  buildDossier,
  MAX_CHECKS_DETALHADOS,
  TOLERANCIA_PADRAO_CENTAVOS,
  type CoverageWindow,
  type DossierInput,
  type OwnDocument,
} from '../../../src/fiscal/dossier/credit-backing.js';
import type {
  SpedCarriedCredit,
  SpedDocument,
} from '../../../src/fiscal/dossier/sped-parser.js';

const CHAVE = '35230912345678000195550010000000011234567893';
const PERIODO = '2023-09';

function spedDoc(override: Partial<SpedDocument> = {}): SpedDocument {
  return {
    line: 10,
    operation: 'inbound',
    model: '55',
    accessKey: CHAVE,
    documentNumber: '1',
    issuedAt: '2023-09-15',
    totalCents: 100_000,
    items: [
      {
        itemNumber: 1,
        code: 'SKU-1',
        cfop: '1102',
        totalCents: 100_000,
        pis: { cst: '50', baseCents: 100_000, rate: 1.65, amountCents: 1_650 },
        cofins: { cst: '50', baseCents: 100_000, rate: 7.6, amountCents: 7_600 },
      },
    ],
    ...override,
  };
}

function nosso(override: Partial<OwnDocument> = {}): OwnDocument {
  return { accessKey: CHAVE, period: PERIODO, pisCents: 1_650, cofinsCents: 7_600, ...override };
}

const cobertura = (...periodos: string[]): CoverageWindow => ({
  periods: new Set(periodos),
  from: periodos.length === 0 ? null : [...periodos].sort()[0]!,
  to: periodos.length === 0 ? null : [...periodos].sort().at(-1)!,
});

function saldo(override: Partial<SpedCarriedCredit> = {}): SpedCarriedCredit {
  return {
    tax: 'pis',
    originPeriod: '2023-01',
    creditCode: '101',
    origin: '0',
    apuredCents: 500_000,
    availableCents: 500_000,
    usedCents: 0,
    refundedCents: 0,
    finalBalanceCents: 500_000,
    ...override,
  };
}

const montar = (override: Partial<DossierInput> = {}) =>
  buildDossier({
    spedDocuments: [spedDoc()],
    carriedCredits: [],
    ownDocuments: [nosso()],
    coverage: cobertura(PERIODO),
    period: PERIODO,
    ...override,
  });

describe('lastro documental do crédito', () => {
  it('documento na base com valores conferentes é lastreado', () => {
    const r = montar();

    expect(r.checks[0]!.status).toBe('lastreado');
    expect(r.checks[0]!.differenceCents).toBe(0);
    expect(r.summary.backedCents).toBe(9_250);
  });

  it('valores divergentes apontam a diferença e sugerem conferir qual está certo', () => {
    const r = montar({ ownDocuments: [nosso({ pisCents: 2_000 })] });

    expect(r.checks[0]!.status).toBe('divergente');
    expect(r.checks[0]!.differenceCents).toBe(350);
    expect(r.checks[0]!.reason).toMatch(/qual dos dois está certo/);
    expect(r.summary.divergentCents).toBe(9_250);
  });

  it('diferença dentro da tolerância não é divergência', () => {
    const r = montar({
      ownDocuments: [nosso({ pisCents: 1_650 + TOLERANCIA_PADRAO_CENTAVOS })],
    });

    expect(r.checks[0]!.status).toBe('lastreado');
  });

  it('a tolerância é configurável', () => {
    const r = montar({ ownDocuments: [nosso({ pisCents: 1_700 })], toleranceCents: 100 });

    expect(r.checks[0]!.status).toBe('lastreado');
  });

  describe('ausência de documento', () => {
    /**
     * Dentro da cobertura, a ausência é do cliente: é o caso que o pente-fino
     * cobra.
     */
    it('dentro da cobertura, documento ausente é crédito sem lastro', () => {
      const r = montar({ ownDocuments: [] });

      expect(r.checks[0]!.status).toBe('sem_documento');
      expect(r.checks[0]!.reason).toMatch(/pente-fino cobra/);
      expect(r.summary.unbackedCents).toBe(9_250);
    });

    /**
     * A honestidade central da onda: se o escritório só começou a ingerir XML
     * em 2026, um crédito de 2023 não tem como ser conferido aqui — e reportá-lo
     * como "sem documento" acusaria o cliente de um problema que é nosso.
     */
    it('fora da cobertura, documento ausente é NÃO VERIFICÁVEL, não sem lastro', () => {
      const r = montar({ ownDocuments: [], coverage: cobertura('2026-01', '2026-02') });

      expect(r.checks[0]!.status).toBe('nao_verificavel');
      expect(r.checks[0]!.status).not.toBe('sem_documento');
      expect(r.checks[0]!.reason).toMatch(/limitação da nossa coleta/);
      expect(r.summary.unbackedCents).toBe(0);
      expect(r.summary.unverifiableCents).toBe(9_250);
    });

    it('a mensagem diz qual é a janela coberta', () => {
      const r = montar({ ownDocuments: [], coverage: cobertura('2026-01', '2026-12') });

      expect(r.checks[0]!.reason).toContain('de 2026-01 a 2026-12');
    });

    it('cobertura de um único mês é descrita como tal', () => {
      const r = montar({ ownDocuments: [], coverage: cobertura('2026-05') });

      expect(r.checks[0]!.reason).toContain('apenas 2026-05');
    });

    it('base sem documento nenhum é descrita sem inventar janela', () => {
      const r = montar({ ownDocuments: [], coverage: cobertura() });

      expect(r.checks[0]!.status).toBe('nao_verificavel');
      expect(r.checks[0]!.reason).toMatch(/nenhuma competência com documento/);
    });
  });

  /**
   * Nota em papel existe e não é erro. Tratá-la como "sem documento" acusaria o
   * cliente de uma limitação do formato.
   */
  it('documento sem chave de acesso não é acusado de falta de lastro', () => {
    const r = montar({ spedDocuments: [spedDoc({ accessKey: null })] });

    expect(r.checks[0]!.status).toBe('sem_chave');
    expect(r.checks[0]!.reason).toMatch(/não é indício de crédito indevido/);
    expect(r.summary.unbackedCents).toBe(0);
    expect(r.summary.unverifiableCents).toBe(9_250);
  });

  /**
   * Conferir a saída reportaria o débito do cliente como crédito sem lastro —
   * inverteria o sinal do dossiê inteiro.
   */
  it('documento de saída não entra na conferência de crédito', () => {
    const r = montar({ spedDocuments: [spedDoc({ operation: 'outbound' })] });

    expect(r.checks).toHaveLength(0);
    expect(r.summary.documentsChecked).toBe(0);
  });

  it('soma PIS e Cofins de todos os itens do documento', () => {
    const doisItens = spedDoc();
    doisItens.items.push({ ...doisItens.items[0]!, itemNumber: 2 });

    const r = montar({
      spedDocuments: [doisItens],
      ownDocuments: [nosso({ pisCents: 3_300, cofinsCents: 15_200 })],
    });

    expect(r.checks[0]!.declared).toEqual({ pisCents: 3_300, cofinsCents: 15_200 });
    expect(r.checks[0]!.status).toBe('lastreado');
  });

  it('conta cada situação no resumo', () => {
    const outra = `${CHAVE.slice(0, 43)}0`;
    const r = montar({
      spedDocuments: [
        spedDoc(),
        spedDoc({ accessKey: outra }),
        spedDoc({ accessKey: null }),
        spedDoc({ operation: 'outbound' }),
      ],
      ownDocuments: [nosso()],
    });

    expect(r.summary.documentsChecked).toBe(3);
    expect(r.summary.lastreado).toBe(1);
    expect(r.summary.sem_documento).toBe(1);
    expect(r.summary.sem_chave).toBe(1);
  });

  it('corta o detalhe mantendo a contagem exata no resumo', () => {
    const total = MAX_CHECKS_DETALHADOS + 10;
    const documentos = Array.from({ length: total }, (_, i) =>
      spedDoc({ accessKey: `${CHAVE.slice(0, 40)}${String(i).padStart(4, '0')}` }),
    );

    const r = montar({ spedDocuments: documentos, ownDocuments: [] });

    expect(r.checks).toHaveLength(MAX_CHECKS_DETALHADOS);
    expect(r.summary.documentsChecked).toBe(total);
    expect(r.summary.sem_documento).toBe(total);
  });
});

describe('saldo credor de períodos anteriores', () => {
  it('soma o saldo final por tributo', () => {
    const r = montar({
      carriedCredits: [
        saldo({ tax: 'pis', finalBalanceCents: 500_000 }),
        saldo({ tax: 'cofins', finalBalanceCents: 2_300_000 }),
      ],
    });

    expect(r.summary.carriedBalanceCents).toEqual({ pis: 500_000, cofins: 2_300_000 });
  });

  it('marca o saldo cuja competência de origem está coberta', () => {
    const r = montar({
      carriedCredits: [saldo({ originPeriod: '2026-03' })],
      coverage: cobertura('2026-03'),
    });

    expect(r.carried[0]!.withinCoverage).toBe(true);
    expect(r.carried[0]!.note).toMatch(/pode ser conferido/);
  });

  /**
   * O sistema não pode confirmar nem negar um saldo de competência que nunca
   * coletou, e a nota tem de dizer as duas coisas.
   */
  it('saldo fora da cobertura diz que não pode ser confirmado nem negado', () => {
    const r = montar({
      carriedCredits: [saldo({ originPeriod: '2019-01' })],
      coverage: cobertura('2026-01'),
    });

    expect(r.carried[0]!.withinCoverage).toBe(false);
    expect(r.carried[0]!.note).toMatch(/não tem como confirmá-lo nem negá-lo/);
  });

  it('a fração coberta do saldo é a razão em valor, não em contagem', () => {
    const r = montar({
      carriedCredits: [
        saldo({ originPeriod: '2026-01', finalBalanceCents: 750_000 }),
        saldo({ originPeriod: '2019-01', finalBalanceCents: 250_000 }),
      ],
      coverage: cobertura('2026-01'),
    });

    expect(r.summary.carriedWithinCoverageRatio).toBeCloseTo(0.75, 5);
  });

  /** Zero saldo não é "zero por cento coberto": é nada a cobrir. */
  it('sem saldo credor, a fração coberta é 1 e não uma divisão por zero', () => {
    const r = montar({ carriedCredits: [] });

    expect(r.summary.carriedWithinCoverageRatio).toBe(1);
    expect(Number.isNaN(r.summary.carriedWithinCoverageRatio)).toBe(false);
  });

  it('preserva os valores declarados de cada saldo', () => {
    const r = montar({
      carriedCredits: [saldo({ apuredCents: 900_000, usedCents: 400_000 })],
    });

    expect(r.carried[0]!.apuredCents).toBe(900_000);
    expect(r.carried[0]!.usedCents).toBe(400_000);
    expect(r.carried[0]!.creditCode).toBe('101');
  });
});
