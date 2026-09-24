import type { Regime } from '../fiscal/shared/fiscal-vocabulary.js';
import {
  allocateTiers,
  type PricingTier,
  type TierSlice,
  type TierAllocationInput,
} from './volume-tiers.js';

/**
 * Cálculo do preço da assinatura. Função pura e sem I/O de propósito: é o número
 * que vai na fatura do escritório, e precisa ser testável linha a linha e
 * reproduzível fora do banco.
 *
 * Os valores **não** ficam aqui: vêm das tabelas `plans`, `billing_settings` e
 * `pricing_tiers`. O briefing é explícito em que R$ 9 / 29 / 49 / 89 são hipótese
 * para teste de preço, não benchmark — hardcodá-los obrigaria deploy para mudar
 * preço.
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
  /**
   * Degressão por volume. Vazia ou ausente = modelo linear, como antes das
   * faixas existirem. Ver `volume-tiers.ts` para o porquê de ser marginal.
   */
  tiers?: readonly PricingTier[];
  /**
   * Teto da assinatura, em centavos. Ausente = sem teto. Existe porque a faixa
   * sozinha não fecha a conta no topo do público-alvo: o desconto marginal é
   * limitado a 50% por monotonicidade, e carteira de milhares de CNPJs precisa
   * de um número negociável que não dependa da posição de ninguém.
   */
  capCents?: number;
}

/** Contagem por regime — a forma mínima que reproduz uma cotação. */
export interface RegimeCount {
  regime: Regime;
  quantity: number;
}

export interface PriceLine {
  regime: Regime;
  quantity: number;
  /** Preço de tabela, sem desconto. */
  unitCents: number;
  /** `quantity × unitCents`, **bruto**: o desconto não entra escondido aqui. */
  subtotalCents: number;
  /** Desconto de volume atribuído a esta linha. Zero quando não há faixas. */
  volumeDiscountCents: number;
  /** Decomposição por faixa, para a tela explicar a conta. Ausente sem faixas. */
  tiers?: readonly TierSlice[];
}

export interface PriceQuote {
  lines: readonly PriceLine[];
  /** Soma das linhas, **bruta**: antes do desconto, do teto e do piso. */
  subtotalCents: number;
  /** Desconto de volume, sempre >= 0. */
  volumeDiscountCents: number;
  /** Corte aplicado pelo teto, sempre <= 0. */
  capAdjustmentCents: number;
  /** Diferença cobrada quando o valor fica abaixo do mínimo, sempre >= 0. */
  minimumAdjustmentCents: number;
  totalCents: number;
  billableClients: number;
  /** Desconto efetivo sobre o bruto, em pontos-base. Só para exibição. */
  effectiveDiscountBps: number;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Cotação a partir das contagens por regime.
 *
 * As quatro parcelas são visíveis e fecham por soma:
 *
 *     subtotal - desconto + ajusteDeTeto + ajusteDeMinimo === total
 *
 * Nenhum desconto entra escondido dentro do subtotal. É a mesma decisão que já
 * valia para o piso — que entra como ajuste explícito em vez de
 * `max(subtotal, minimo)` — estendida ao desconto e ao teto: o escritório tem de
 * conseguir ver de onde veio cada centavo, que é exatamente o tipo de opacidade
 * que o produto se posiciona contra.
 *
 * Ordem de aplicação: **desconto -> teto -> piso**. O piso é último porque chão
 * ganha de teto.
 */
export function quoteFromCounts(
  counts: readonly RegimeCount[],
  rules: PricingRules,
): PriceQuote {
  if (rules.capCents !== undefined && rules.capCents < rules.minimumCents) {
    // Configuração incoerente: falha alto em vez de escolher em silêncio qual
    // dos dois vale, porque o erro apareceria como fatura errada.
    throw new PricingError(
      `Teto de assinatura (${rules.capCents}) menor que o mínimo (${rules.minimumCents}). ` +
        'Um dos dois está errado na tabela de cobrança.',
    );
  }

  const priceByRegime = new Map(rules.prices.map((price) => [price.regime, price.monthlyCents]));

  const agrupado = new Map<Regime, number>();
  for (const count of counts) {
    if (count.quantity <= 0) {
      continue;
    }
    if (!priceByRegime.has(count.regime)) {
      throw new PricingError(
        `Regime '${count.regime}' não tem preço publicado; não é possível faturar.`,
      );
    }
    agrupado.set(count.regime, (agrupado.get(count.regime) ?? 0) + count.quantity);
  }

  const billableClients = [...agrupado.values()].reduce((soma, n) => soma + n, 0);

  const unidades: TierAllocationInput[] = [...agrupado.entries()].map(([regime, quantity]) => ({
    regime,
    unitCents: priceByRegime.get(regime)!,
    quantity,
  }));

  const allocation = allocateTiers(unidades, rules.tiers ?? []);

  const lines: PriceLine[] = unidades
    .map((unit) => {
      const fatias = allocation.byRegime.get(unit.regime);
      const volumeDiscountCents = (fatias ?? []).reduce((soma, f) => soma + f.discountCents, 0);

      return {
        regime: unit.regime,
        quantity: unit.quantity,
        unitCents: unit.unitCents,
        subtotalCents: unit.unitCents * unit.quantity,
        volumeDiscountCents,
        ...(fatias && fatias.length > 0 ? { tiers: fatias } : {}),
      };
    })
    // Ordem estável para a fatura não mudar de forma entre dois cálculos iguais.
    .sort((a, b) => a.regime.localeCompare(b.regime));

  const subtotalCents = lines.reduce((total, line) => total + line.subtotalCents, 0);
  const volumeDiscountCents = allocation.totalDiscountCents;
  const aposDesconto = subtotalCents - volumeDiscountCents;

  const capAdjustmentCents =
    rules.capCents !== undefined && aposDesconto > rules.capCents
      ? rules.capCents - aposDesconto
      : 0;
  const aposTeto = aposDesconto + capAdjustmentCents;

  // Carteira vazia não paga piso: cobrar mínimo de quem não tem CNPJ ativo é
  // cobrança indevida, e é literalmente a reclamação que o produto usa como
  // contraposicionamento. O piso incide sobre o **líquido**, não sobre o bruto —
  // senão o desconto seria concedido e retomado no mesmo cálculo.
  const minimumAdjustmentCents =
    billableClients === 0 ? 0 : Math.max(0, rules.minimumCents - aposTeto);

  return {
    lines,
    subtotalCents,
    volumeDiscountCents,
    capAdjustmentCents,
    minimumAdjustmentCents,
    totalCents: aposTeto + minimumAdjustmentCents,
    billableClients,
    effectiveDiscountBps: allocation.effectiveDiscountBps,
  };
}

/**
 * Cotação para um conjunto de CNPJs faturáveis. Adaptador sobre
 * `quoteFromCounts`: o cálculo só depende de quantos CNPJs há de cada regime.
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

  return quoteFromCounts(
    [...counts.entries()].map(([regime, quantity]) => ({ regime, quantity })),
    rules,
  );
}

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Versão do formato do snapshot. Faturas emitidas antes das faixas existirem não
 * têm as parcelas novas; a tela bifurca por este número em vez de adivinhar pela
 * presença dos campos.
 */
export const QUOTE_SNAPSHOT_VERSION = 2;

/**
 * Cotação no formato da API. É também o `snapshot` gravado na fatura: a prévia
 * que a tela mostrou e a fatura emitida têm a mesma forma, e a fatura continua
 * explicável depois de o preço da tabela mudar.
 */
export function serializeQuote(result: PriceQuote): Record<string, unknown> {
  return {
    snapshot_version: QUOTE_SNAPSHOT_VERSION,
    billable_clients: result.billableClients,
    lines: result.lines.map((line) => ({
      regime: line.regime,
      quantity: line.quantity,
      unit_cents: line.unitCents,
      subtotal_cents: line.subtotalCents,
      volume_discount_cents: line.volumeDiscountCents,
      ...(line.tiers
        ? {
            tiers: line.tiers.map((tier) => ({
              from_clients: tier.fromClients,
              to_clients: tier.toClients,
              label: tier.label ?? null,
              quantity: tier.quantity,
              discount_bps: tier.discountBps,
              gross_cents: tier.grossCents,
              discount_cents: tier.discountCents,
              net_cents: tier.netCents,
            })),
          }
        : {}),
    })),
    subtotal_cents: result.subtotalCents,
    volume_discount_cents: result.volumeDiscountCents,
    cap_adjustment_cents: result.capAdjustmentCents,
    minimum_adjustment_cents: result.minimumAdjustmentCents,
    effective_discount_bps: result.effectiveDiscountBps,
    total_cents: result.totalCents,
    total_formatted: formatBRL(result.totalCents),
  };
}
