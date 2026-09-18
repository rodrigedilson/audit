import { describe, it, expect } from 'vitest';
import { quote, formatBRL, PricingError, type PricingRules } from '../../src/billing/pricing.js';

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
      { regime: 'lucro_real', quantity: 2, unitCents: 8900, subtotalCents: 17_800 },
      { regime: 'mei', quantity: 3, unitCents: 900, subtotalCents: 2_700 },
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
