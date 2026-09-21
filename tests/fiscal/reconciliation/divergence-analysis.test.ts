import { describe, it, expect } from 'vitest';
import {
  compare,
  MAX_DIVERGENCIAS_DE_ITEM,
  TOLERANCIA_PADRAO_CENTAVOS,
  type ComparableLine,
  type ComparisonInput,
  type Divergence,
} from '../../../src/fiscal/reconciliation/divergence-analysis.js';

const CHAVE_A = '35270912345678000195550010000000011234567893';
const CHAVE_B = '35270912345678000195550010000000021234567890';

function linha(override: Partial<ComparableLine> = {}): ComparableLine {
  return {
    accessKey: CHAVE_A,
    line: 1,
    tax: 'icms',
    direction: 'outbound',
    baseCents: 100_000,
    rate: 18,
    amountCents: 18_000,
    ...override,
  };
}

function comparar(override: Partial<ComparisonInput> = {}) {
  return compare({ ours: [], fisco: [], lineLevel: true, ...override });
}

const causas = (divergencias: readonly Divergence[]): string[] =>
  divergencias.map((d) => d.probableCause);

describe('contra-apuração — comparação nota a nota', () => {
  it('lados idênticos não produzem divergência', () => {
    const r = comparar({ ours: [linha()], fisco: [linha()] });

    expect(r.divergences).toHaveLength(0);
    expect(r.summary.linesCompared).toBe(1);
  });

  describe('causa provável da diferença de valor', () => {
    it('mesma base e alíquota diferente é divergência de alíquota', () => {
      const r = comparar({
        ours: [linha({ rate: 18, amountCents: 18_000 })],
        fisco: [linha({ rate: 12, amountCents: 12_000 })],
      });

      expect(causas(r.divergences)).toEqual(['aliquota_divergente']);
      expect(r.divergences[0]!.differenceCents).toBe(-6_000);
    });

    it('mesma alíquota e base diferente é divergência de base', () => {
      const r = comparar({
        ours: [linha({ baseCents: 100_000, amountCents: 18_000 })],
        fisco: [linha({ baseCents: 150_000, amountCents: 27_000 })],
      });

      expect(causas(r.divergences)).toEqual(['base_divergente']);
      expect(r.divergences[0]!.differenceCents).toBe(9_000);
    });

    it('base e alíquota diferentes não são reportadas como uma só causa', () => {
      const r = comparar({
        ours: [linha({ baseCents: 100_000, rate: 18, amountCents: 18_000 })],
        fisco: [linha({ baseCents: 150_000, rate: 12, amountCents: 18_500 })],
      });

      expect(causas(r.divergences)).toEqual(['base_e_aliquota_divergentes']);
    });

    /**
     * Base e alíquota conferem e o valor não: a aritmética de um dos dois lados
     * não fecha. É achado diferente de enquadramento, e leva a outra conversa.
     */
    it('base e alíquota iguais com valor diferente aponta aritmética que não fecha', () => {
      const r = comparar({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [linha({ amountCents: 17_500 })],
      });

      expect(causas(r.divergences)).toEqual(['valor_incoerente_com_base_e_aliquota']);
    });

    it('diferença de alíquota abaixo de um décimo de milésimo não conta como divergente', () => {
      const r = comparar({
        ours: [linha({ rate: 18.0, amountCents: 18_000 })],
        fisco: [linha({ rate: 18.00005, amountCents: 19_000 })],
      });

      expect(causas(r.divergences)).toEqual(['valor_incoerente_com_base_e_aliquota']);
    });
  });

  describe('linha presente em um lado só', () => {
    /**
     * O achado central do diferencial: o Fisco tem uma nota de saída que nunca
     * entrou na nossa escrita. É débito que será cobrado, e o silêncio o
     * confirma.
     */
    it('saída só no Fisco é débito não escriturado, e é crítica', () => {
      const r = comparar({ ours: [], fisco: [linha({ direction: 'outbound' })] });

      expect(causas(r.divergences)).toEqual(['debito_nao_escriturado']);
      expect(r.divergences[0]!.severity).toBe('critical');
      expect(r.summary.exposureCents).toBe(18_000);
    });

    /** O oposto: crédito que o próprio Fisco reconhece e ninguém aproveitou. */
    it('entrada só no Fisco é crédito não aproveitado, não exposição', () => {
      const r = comparar({ ours: [], fisco: [linha({ direction: 'inbound' })] });

      expect(causas(r.divergences)).toEqual(['credito_nao_aproveitado']);
      expect(r.summary.creditLossCents).toBe(18_000);
      expect(r.summary.exposureCents).toBe(0);
    });

    it('entrada só nossa é crédito sob risco de glosa, e é crítica', () => {
      const r = comparar({ ours: [linha({ direction: 'inbound' })], fisco: [] });

      expect(causas(r.divergences)).toEqual(['credito_glosado']);
      expect(r.divergences[0]!.severity).toBe('critical');
      expect(r.summary.creditAtRiskCents).toBe(18_000);
    });

    it('saída só nossa é débito que o Fisco não reconhece', () => {
      const r = comparar({ ours: [linha({ direction: 'outbound' })], fisco: [] });

      expect(causas(r.divergences)).toEqual(['debito_nao_reconhecido_pelo_fisco']);
      expect(r.divergences[0]!.severity).toBe('medium');
    });

    /**
     * Documento inteiro ausente e item ausente num documento conhecido pelos
     * dois lados são investigações diferentes: a primeira é de coleta, a
     * segunda é de conteúdo da nota.
     */
    it('documento inteiro ausente tem escopo documento, não item', () => {
      const r = comparar({ ours: [], fisco: [linha({ accessKey: CHAVE_B })] });

      expect(r.divergences[0]!.scope).toBe('documento');
      expect(r.divergences[0]!.subject).toBe(CHAVE_B);
      expect(r.divergences[0]!.line).toBeNull();
    });

    it('item ausente em documento conhecido tem escopo item', () => {
      const r = comparar({
        ours: [linha({ line: 1 })],
        fisco: [linha({ line: 1 }), linha({ line: 2, amountCents: 5_000 })],
      });

      const ausente = r.divergences.find((d) => d.line === 2);
      expect(ausente?.scope).toBe('item');
      expect(ausente?.subject).toBe(`${CHAVE_A}#2`);
    });

    /**
     * Netar exposição contra perda de crédito deixaria um milhão de cada lado
     * se cancelarem na tela, e o escritório concluiria que está tudo certo.
     */
    it('exposição e perda de crédito não se cancelam no resumo', () => {
      const r = comparar({
        ours: [],
        fisco: [
          linha({ direction: 'outbound', amountCents: 100_000 }),
          linha({ accessKey: CHAVE_B, direction: 'inbound', amountCents: 100_000 }),
        ],
      });

      expect(r.summary.exposureCents).toBe(100_000);
      expect(r.summary.creditLossCents).toBe(100_000);
    });
  });

  describe('arredondamento', () => {
    it('diferença dentro da tolerância não vira divergência de item', () => {
      const r = comparar({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [linha({ amountCents: 18_000 + TOLERANCIA_PADRAO_CENTAVOS })],
      });

      expect(r.divergences.filter((d) => d.scope === 'item')).toHaveLength(0);
    });

    /**
     * Mil linhas com um centavo de diferença viram mil itens que ninguém lê e
     * escondem a divergência que importa. Somadas por tributo, viram uma linha.
     */
    it('centavos de mil linhas somam numa divergência única por tributo', () => {
      const nossas = Array.from({ length: 1_000 }, (_, i) =>
        linha({ line: i + 1, amountCents: 18_000 }),
      );
      const deles = nossas.map((l) => ({ ...l, amountCents: l.amountCents + 1 }));

      const r = comparar({ ours: nossas, fisco: deles });

      expect(r.divergences).toHaveLength(1);
      expect(r.divergences[0]!.probableCause).toBe('arredondamento');
      expect(r.divergences[0]!.differenceCents).toBe(1_000);
      expect(r.divergences[0]!.severity).toBe('low');
    });

    it('arredondamentos que se anulam não geram achado', () => {
      const r = comparar({
        ours: [linha({ line: 1 }), linha({ line: 2 })],
        fisco: [
          linha({ line: 1, amountCents: 18_001 }),
          linha({ line: 2, amountCents: 17_999 }),
        ],
      });

      expect(r.divergences).toHaveLength(0);
    });

    it('a tolerância é configurável por comparação', () => {
      const r = comparar({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [linha({ amountCents: 18_050 })],
        toleranceCents: 100,
      });

      expect(causas(r.divergences)).toEqual(['arredondamento']);
    });
  });

  describe('proposta só com totais', () => {
    /**
     * A honestidade da onda. Sem detalhe a comparação nota a nota não acontece,
     * e reportar zero divergências de item seria lido como "confere".
     */
    it('declara que nada foi comparado linha a linha', () => {
      const r = compare({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [],
        fiscoTotals: { icms: 18_000 },
        lineLevel: false,
      });

      expect(r.summary.lineLevel).toBe(false);
      expect(r.summary.linesCompared).toBe(0);
      expect(r.divergences).toHaveLength(0);
    });

    it('diferença de total aparece mesmo sem detalhe, com causa não determinada', () => {
      const r = compare({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [],
        fiscoTotals: { icms: 25_000 },
        lineLevel: false,
      });

      expect(causas(r.divergences)).toEqual(['causa_nao_determinada']);
      expect(r.divergences[0]!.differenceCents).toBe(7_000);
      expect(r.divergences[0]!.scope).toBe('tributo');
    });

    it('tributo que só o Fisco aponta aparece no total', () => {
      const r = compare({
        ours: [],
        fisco: [],
        fiscoTotals: { cbs: 92_100 },
        lineLevel: false,
      });

      expect(r.divergences[0]!.tax).toBe('cbs');
      expect(r.divergences[0]!.ourCents).toBe(0);
      expect(r.divergences[0]!.fiscoCents).toBe(92_100);
    });
  });

  describe('total contra as linhas', () => {
    /** Com detalhe, repetir o total duplicaria o valor na tela. */
    it('total explicado pelas linhas não é reportado de novo', () => {
      const r = compare({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [linha({ amountCents: 12_000, rate: 12 })],
        fiscoTotals: { icms: 12_000 },
        lineLevel: true,
      });

      expect(causas(r.divergences)).toEqual(['aliquota_divergente']);
    });

    /**
     * Um centavo de arredondamento explica o total tanto quanto uma divergência
     * de alíquota. Sem contá-lo, o achado mais banal disparava o alarme mais
     * grave do módulo.
     */
    it('arredondamento explica o total e não vira "total que não fecha"', () => {
      const r = compare({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [linha({ amountCents: 18_001 })],
        fiscoTotals: { icms: 18_001 },
        lineLevel: true,
      });

      expect(causas(r.divergences)).toEqual(['arredondamento']);
      expect(r.summary.bySeverity.critical).toBe(0);
    });

    /**
     * Total que as linhas não explicam é o pior caso: significa que a própria
     * proposta não fecha consigo mesma, e nenhum número dela é confiável.
     */
    it('total que as linhas não explicam é crítico e fica visível', () => {
      const r = compare({
        ours: [linha({ amountCents: 18_000 })],
        fisco: [linha({ amountCents: 18_000 })],
        fiscoTotals: { icms: 50_000 },
        lineLevel: true,
      });

      const total = r.divergences.find((d) => d.scope === 'tributo');
      expect(total?.probableCause).toBe('total_nao_explicado_pelas_linhas');
      expect(total?.severity).toBe('critical');
      expect(total?.differenceCents).toBe(32_000);
    });
  });

  describe('ordenação e corte', () => {
    it('crítico vem antes de alto, e o maior valor antes do menor', () => {
      const r = comparar({
        ours: [linha({ line: 1, amountCents: 18_000 })],
        fisco: [
          linha({ line: 1, rate: 12, amountCents: 12_000 }),
          linha({ line: 2, direction: 'outbound', amountCents: 1_000 }),
          linha({ line: 3, direction: 'outbound', amountCents: 90_000 }),
        ],
      });

      expect(r.divergences[0]!.differenceCents).toBe(90_000);
      expect(r.divergences[1]!.differenceCents).toBe(1_000);
      expect(r.divergences[2]!.probableCause).toBe('aliquota_divergente');
    });

    it('corta as divergências de item mantendo a contagem exata no resumo', () => {
      const total = MAX_DIVERGENCIAS_DE_ITEM + 50;
      const nossas = Array.from({ length: total }, (_, i) =>
        linha({ line: i + 1, amountCents: 18_000 }),
      );
      const deles = nossas.map((l) => ({ ...l, rate: 12, amountCents: 12_000 }));

      const r = comparar({ ours: nossas, fisco: deles });

      expect(r.divergences).toHaveLength(MAX_DIVERGENCIAS_DE_ITEM);
      expect(r.summary.divergencesCount).toBe(total);
    });

    it('o corte de item não descarta divergência de documento nem de tributo', () => {
      const nossas = Array.from({ length: MAX_DIVERGENCIAS_DE_ITEM + 10 }, (_, i) =>
        linha({ line: i + 1 }),
      );
      const deles = nossas.map((l) => ({ ...l, rate: 12, amountCents: 12_000 }));

      const r = comparar({
        ours: nossas,
        fisco: [...deles, linha({ accessKey: CHAVE_B, direction: 'outbound' })],
      });

      expect(r.divergences.some((d) => d.scope === 'documento')).toBe(true);
    });
  });

  it('conta as divergências por gravidade', () => {
    const r = comparar({
      ours: [linha({ line: 1, direction: 'inbound' })],
      fisco: [linha({ line: 2, direction: 'outbound' })],
    });

    expect(r.summary.bySeverity.critical).toBe(2);
    expect(r.summary.divergencesCount).toBe(2);
  });
});
