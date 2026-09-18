import type { Regime } from '../fiscal/shared/fiscal-vocabulary.js';

/**
 * Cálculo do preço da assinatura. Função pura e sem I/O de propósito: é o número
 * que vai na fatura do escritório, e precisa ser testável linha a linha e
 * reproduzível fora do banco.
 *
 * Os valores **não** ficam aqui: vêm da tabela `plans`. O briefing é explícito
 * em que R$ 9 / 29 / 49 / 89 são hipótese para teste de preço, não benchmark —
 * hardcodá-los obrigaria deploy para mudar preço.
 */

export interface PlanPrice {
  regime: Regime;
  monthlyCents: number;
}

export interface BillableClient {
  cnpj: string;
  regime: Regime;
}

export interface PricingRules {
  /** Preço por regime, em centavos. */
  prices: readonly PlanPrice[];
  /** Assinatura mínima (piso da fatura), em centavos. Briefing: R$ 150. */
  minimumCents: number;
}

export interface PriceLine {
  regime: Regime;
  quantity: number;
  unitCents: number;
  subtotalCents: number;
}

export interface PriceQuote {
  lines: readonly PriceLine[];
  /** Soma das linhas, antes do piso. */
  subtotalCents: number;
  /** Diferença cobrada quando o subtotal fica abaixo do mínimo. */
  minimumAdjustmentCents: number;
  totalCents: number;
  billableClients: number;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Cotação para um conjunto de CNPJs faturáveis.
 *
 * O piso entra como **ajuste explícito**, não substituindo o total: o escritório
 * tem de conseguir ver que pagou o mínimo e quanto faltava para atingi-lo. Um
 * `max(subtotal, minimo)` daria o mesmo número e esconderia a explicação, que é
 * exatamente o tipo de opacidade que o produto se posiciona contra.
 */
export function quote(clients: readonly BillableClient[], rules: PricingRules): PriceQuote {
  const priceByRegime = new Map(rules.prices.map((price) => [price.regime, price.monthlyCents]));

  const counts = new Map<Regime, number>();
  for (const client of clients) {
    if (!priceByRegime.has(client.regime)) {
      throw new PricingError(
        `Regime '${client.regime}' não tem preço publicado; não é possível faturar o CNPJ ${client.cnpj}.`,
      );
    }
    counts.set(client.regime, (counts.get(client.regime) ?? 0) + 1);
  }

  const lines: PriceLine[] = [...counts.entries()]
    .map(([regime, quantity]) => {
      const unitCents = priceByRegime.get(regime)!;
      return { regime, quantity, unitCents, subtotalCents: unitCents * quantity };
    })
    // Ordem estável para a fatura não mudar de forma entre dois cálculos iguais.
    .sort((a, b) => a.regime.localeCompare(b.regime));

  const subtotalCents = lines.reduce((total, line) => total + line.subtotalCents, 0);

  // Carteira vazia não paga piso: cobrar mínimo de quem não tem CNPJ ativo é
  // cobrança indevida, e é literalmente a reclamação que o produto usa como
  // contraposicionamento.
  const minimumAdjustmentCents =
    clients.length === 0 ? 0 : Math.max(0, rules.minimumCents - subtotalCents);

  return {
    lines,
    subtotalCents,
    minimumAdjustmentCents,
    totalCents: subtotalCents + minimumAdjustmentCents,
    billableClients: clients.length,
  };
}

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
