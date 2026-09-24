import { describe, it, expect } from 'vitest';
import {
  quote,
  quoteFromCounts,
  serializeQuote,
  formatBRL,
  PricingError,
  QUOTE_SNAPSHOT_VERSION,
  type PricingRules,
} from '../../src/billing/pricing.js';
import type { PricingTier } from '../../src/billing/volume-tiers.js';

/** Preços do briefing, em centavos. Hipótese de teste de preço, não benchmark. */
const rules: PricingRules = {
  prices: [
    { regime: 'mei', monthlyCents: 900 },
    { regime: 'simples_integrado', monthlyCents: 900 },
    { regime: 'simples_hibrido', monthlyCents: 2900 },
    { regime: 'lucro_presumido', monthlyCents: 4900 },
    { regime: 'lucro_real', monthlyCents: 8900 },
  ],
  minimumCents: 15000,
};

const clients = (regime: PricingRules['prices'][number]['regime'], quantity: number) =>
  Array.from({ length: quantity }, (_, i) => ({ cnpj: `${regime}-${i}`, regime }));

describe('quote — cálculo da assinatura', () => {
  it('soma por regime', () => {
    // 10 × 29 + 4 × 49 = 290 + 196 = 486
    const result = quote(
      [...clients('simples_hibrido', 10), ...clients('lucro_presumido', 4)],
      rules,
    );

    expect(result.subtotalCents).toBe(48_600);
    expect(result.totalCents).toBe(48_600);
    expect(result.minimumAdjustmentCents).toBe(0);
    expect(result.billableClients).toBe(14);
  });

  it('agrupa em uma linha por regime, com quantidade', () => {
    const result = quote([...clients('mei', 3), ...clients('lucro_real', 2)], rules);

    expect(result.lines).toEqual([
      {
        regime: 'lucro_real',
        quantity: 2,
        unitCents: 8900,
        subtotalCents: 17_800,
        volumeDiscountCents: 0,
      },
      { regime: 'mei', quantity: 3, unitCents: 900, subtotalCents: 2_700, volumeDiscountCents: 0 },
    ]);
  });

  /**
   * O piso entra como ajuste explícito em vez de `max(subtotal, minimo)`: dá o
   * mesmo total e permite à tela explicar a conta, em vez de mostrar um número
   * que não fecha com as linhas.
   */
  it('aplica o mínimo como ajuste visível, não substituindo o subtotal', () => {
    // 5 MEI = R$ 45, abaixo do mínimo de R$ 150.
    const result = quote(clients('mei', 5), rules);

    expect(result.subtotalCents).toBe(4_500);
    expect(result.minimumAdjustmentCents).toBe(10_500);
    expect(result.totalCents).toBe(15_000);
    // A conta fecha: subtotal + ajuste = total.
    expect(result.subtotalCents + result.minimumAdjustmentCents).toBe(result.totalCents);
  });

  it('não aplica ajuste quando o subtotal atinge o mínimo exatamente', () => {
    // 3 × 4900 = 14700; 1 MEI = 900 → 15600, acima do piso.
    const result = quote([...clients('lucro_presumido', 3), ...clients('mei', 1)], rules);

    expect(result.subtotalCents).toBe(15_600);
    expect(result.minimumAdjustmentCents).toBe(0);
  });

  /**
   * Cobrar piso de quem não tem CNPJ ativo é cobrança indevida — literalmente a
   * reclamação que o produto usa como contraposicionamento.
   */
  it('carteira vazia não paga o mínimo', () => {
    const result = quote([], rules);

    expect(result.totalCents).toBe(0);
    expect(result.minimumAdjustmentCents).toBe(0);
    expect(result.lines).toEqual([]);
  });

  it('o resultado é estável entre duas execuções com a mesma entrada', () => {
    const entrada = [...clients('simples_hibrido', 7), ...clients('mei', 2)];

    expect(quote(entrada, rules)).toEqual(quote(entrada, rules));
  });

  it('a ordem dos CNPJs na entrada não muda a fatura', () => {
    const a = [...clients('mei', 2), ...clients('lucro_real', 1)];
    const b = [...clients('lucro_real', 1), ...clients('mei', 2)];

    expect(quote(a, rules)).toEqual(quote(b, rules));
  });

  /**
   * Falha alto em vez de faturar zero: um regime sem preço publicado seria um
   * CNPJ trabalhado e não cobrado, e o erro só apareceria no fim do mês.
   */
  it('recusa faturar CNPJ de regime sem preço publicado', () => {
    const rulesSemMei: PricingRules = {
      prices: rules.prices.filter((price) => price.regime !== 'mei'),
      minimumCents: rules.minimumCents,
    };

    expect(() => quote(clients('mei', 1), rulesSemMei)).toThrow(PricingError);
    expect(() => quote(clients('mei', 1), rulesSemMei)).toThrow(/não tem preço publicado/);
  });

  it('usa centavos, sem erro de ponto flutuante na soma', () => {
    // 300 CNPJs é o topo do público-alvo do briefing.
    const result = quote(clients('simples_hibrido', 300), rules);

    expect(result.totalCents).toBe(870_000);
    expect(Number.isInteger(result.totalCents)).toBe(true);
  });
});

describe('formatBRL', () => {
  it('formata em real brasileiro', () => {
    expect(formatBRL(15_000).replace(/ /g, ' ')).toBe('R$ 150,00');
    expect(formatBRL(900).replace(/ /g, ' ')).toBe('R$ 9,00');
  });
});

/** Escada semeada pela migration de faixas. */
const tiers: PricingTier[] = [
  { fromClients: 1, discountBps: 0, label: 'Até 100 CNPJs' },
  { fromClients: 101, discountBps: 1500, label: '101 a 300 CNPJs' },
  { fromClients: 301, discountBps: 3000, label: '301 a 600 CNPJs' },
  { fromClients: 601, discountBps: 4000, label: '601 a 1.000 CNPJs' },
  { fromClients: 1001, discountBps: 5000, label: 'Acima de 1.000 CNPJs' },
];

const comFaixas: PricingRules = { ...rules, tiers };

describe('quoteFromCounts — parcelas visíveis', () => {
  /**
   * A invariante que sustenta a tela: as quatro parcelas fecham por soma, e
   * nenhum desconto entra escondido dentro do subtotal.
   */
  it('subtotal − desconto + teto + piso fecha com o total', () => {
    const cenarios: { counts: { regime: PricingRules['prices'][number]['regime']; quantity: number }[]; rules: PricingRules }[] = [
      { counts: [{ regime: 'simples_hibrido', quantity: 1200 }], rules: comFaixas },
      { counts: [{ regime: 'mei', quantity: 3 }], rules: comFaixas },
      { counts: [{ regime: 'lucro_real', quantity: 500 }], rules: { ...comFaixas, capCents: 2_000_000 } },
      { counts: [{ regime: 'lucro_presumido', quantity: 40 }], rules: rules },
      { counts: [], rules: comFaixas },
    ];

    for (const cenario of cenarios) {
      const r = quoteFromCounts(cenario.counts, cenario.rules);
      expect(
        r.subtotalCents - r.volumeDiscountCents + r.capAdjustmentCents + r.minimumAdjustmentCents,
      ).toBe(r.totalCents);
    }
  });

  it('sem faixas o resultado é o linear de sempre', () => {
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 500 }], rules);

    expect(r.volumeDiscountCents).toBe(0);
    expect(r.effectiveDiscountBps).toBe(0);
    expect(r.totalCents).toBe(500 * 2900);
  });

  it('carteira pequena não muda de preço com a escada ligada', () => {
    const semFaixas = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 10 }], rules);
    const comEscada = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 10 }], comFaixas);

    expect(comEscada.volumeDiscountCents).toBe(0);
    expect(comEscada.totalCents).toBe(semFaixas.totalCents);
  });

  it('o caso do briefing: 1.200 CNPJs saem de R$ 34.800 para R$ 23.780', () => {
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 1200 }], comFaixas);

    expect(r.subtotalCents).toBe(3_480_000);
    expect(r.volumeDiscountCents).toBe(1_102_000);
    expect(r.totalCents).toBe(2_378_000);
  });

  it('o teto corta acima e aparece como parcela negativa', () => {
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 1200 }], {
      ...comFaixas,
      capCents: 900_000,
    });

    expect(r.capAdjustmentCents).toBe(900_000 - 2_378_000);
    expect(r.totalCents).toBe(900_000);
  });

  it('teto que não morde não aparece', () => {
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 20 }], {
      ...comFaixas,
      capCents: 5_000_000,
    });

    expect(r.capAdjustmentCents).toBe(0);
  });

  it('recusa teto abaixo do mínimo, em vez de escolher um dos dois em silêncio', () => {
    expect(() =>
      quoteFromCounts([{ regime: 'mei', quantity: 1 }], { ...comFaixas, capCents: 10_000 }),
    ).toThrow(PricingError);
  });

  it('o piso incide sobre o líquido, não sobre o bruto', () => {
    // Teto derruba abaixo do piso: o mínimo volta a morder sobre o valor já cortado.
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 1200 }], {
      ...comFaixas,
      capCents: 15_000,
    });

    expect(r.totalCents).toBe(15_000);
    expect(r.minimumAdjustmentCents).toBe(0);
  });

  it('quote e quoteFromCounts produzem a mesma cotação', () => {
    const porCliente = quote(
      [...clients('simples_hibrido', 150), ...clients('mei', 20)],
      comFaixas,
    );
    const porContagem = quoteFromCounts(
      [
        { regime: 'simples_hibrido', quantity: 150 },
        { regime: 'mei', quantity: 20 },
      ],
      comFaixas,
    );

    expect(porCliente).toEqual(porContagem);
  });

  it('cada linha traz a decomposição por faixa quando há desconto', () => {
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 150 }], comFaixas);
    const linha = r.lines[0]!;

    expect(linha.subtotalCents).toBe(150 * 2900);
    expect(linha.tiers).toHaveLength(2);
    expect(linha.volumeDiscountCents).toBe(
      linha.tiers!.reduce((soma, t) => soma + t.discountCents, 0),
    );
  });
});

describe('serializeQuote', () => {
  it('carimba a versão do snapshot e mantém o subtotal bruto', () => {
    const r = quoteFromCounts([{ regime: 'simples_hibrido', quantity: 1200 }], comFaixas);
    const json = serializeQuote(r);

    expect(json['snapshot_version']).toBe(QUOTE_SNAPSHOT_VERSION);
    expect(json['subtotal_cents']).toBe(3_480_000);
    expect(json['volume_discount_cents']).toBe(1_102_000);
    expect(json['total_cents']).toBe(2_378_000);
  });
});
