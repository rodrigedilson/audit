import type { Regime } from '../fiscal/shared/fiscal-vocabulary.js';

/**
 * Degressão por volume.
 *
 * O preço linear por CNPJ quebra no topo do público-alvo: uma carteira de 1.200
 * CNPJs de Simples Híbrido custaria R$ 34.800/mês, que nenhum escritório paga.
 * A degressão resolve a faixa de 300 a 1.000; acima disso quem carrega é o teto
 * (`capCents`), e não esta tabela — ver a nota sobre 50% mais abaixo.
 *
 * ---------------------------------------------------------------------------
 * Por que **marginal** (estilo alíquota de IR) e não desconto sobre o total
 * ---------------------------------------------------------------------------
 * Desconto de faixa aplicado ao total inteiro cria penhasco. Com 15% a partir
 * de 101 CNPJs de Simples Híbrido: 100 custam R$ 2.900,00 e 101 custam
 * R$ 2.492,15. **Acrescentar um cliente baixa a fatura.** Num produto que se
 * vende contra opacidade de preço, uma tabela onde crescer sai mais barato é
 * indefensável na tela, e vira arbitragem — o escritório cadastra um CNPJ
 * inativo só para atravessar a faixa.
 *
 * ---------------------------------------------------------------------------
 * Por que a alocação é por preço unitário **decrescente**
 * ---------------------------------------------------------------------------
 * O preço é por regime e a faixa é por quantidade total, então é preciso decidir
 * qual CNPJ ocupa qual posição. Duas saídas parecem certas e são erradas:
 *
 * 1. **Ratear o desconto proporcionalmente** entre as linhas (um fator efetivo
 *    único aplicado a todas). É elegante e é não-monotônico:
 *      100 × lucro_real (R$ 89) = R$ 8.900,00
 *      + 1 MEI (R$ 9)           = R$ 8.895,73
 *    O MEI tem preço marginal negativo. Isso chega ao suporte.
 *
 * 2. **Alocar do mais barato para o mais caro**, para os CNPJs caros pegarem as
 *    faixas com desconto. Comercialmente simpático, matematicamente pior:
 *    acrescentar um MEI empurra um lucro_real para a faixa seguinte e derruba a
 *    fatura com folga.
 *
 * A ordem correta é **decrescente** (empate desfeito pelo nome do regime, para
 * ser determinística): os CNPJs mais caros ocupam as primeiras posições, que são
 * as sem desconto, e qualquer CNPJ acrescentado só empurra os **mais baratos**
 * faixa acima. De brinde vêm duas propriedades que a fatura precisa ter — a
 * ordem de entrada não influi (a chave de ordenação é o preço, nunca o índice do
 * array), e cada regime ocupa um intervalo **contíguo** de posições, porque todo
 * CNPJ de um regime tem o mesmo preço. Sem contiguidade a decomposição por faixa
 * viraria uma nuvem de frações impossível de mostrar.
 *
 * ---------------------------------------------------------------------------
 * Por que o desconto máximo é 50%, e por que isso não é gosto comercial
 * ---------------------------------------------------------------------------
 * A alocação decrescente ainda não é incondicionalmente monotônica: acrescentar
 * um CNPJ caro o insere no começo e empurra um "atravessador" por fronteira de
 * faixa. O saldo líquido de acrescentar um CNPJ de preço `p` é
 *
 *     ganho = p × (1 − d_da_posição)
 *     perda ≤ p × (d_max − d_1)      [os atravessadores custam no máximo `p`]
 *
 * Com `d_1 = 0`, o saldo é `≥ p × (1 − 2·d_max)`, **positivo se e somente se
 * `d_max < 50%`**. Daí o teto de 5000 bps aqui e o `check` equivalente no banco.
 * Quem precisar de degressão além de 50% usa o teto de fatura, que é um
 * mecanismo diferente e não quebra a monotonicidade porque não depende da
 * posição de ninguém.
 */

/** Faixa de volume. `discountBps` é **marginal**: vale só dentro da faixa. */
export interface PricingTier {
  /** Primeira posição da faixa, 1-based. A primeira faixa sempre começa em 1. */
  fromClients: number;
  /** Desconto em pontos-base (1500 = 15%). Teto de 5000 — ver monotonicidade. */
  discountBps: number;
  label?: string;
}

/** Unidade de alocação: um regime, seu preço de tabela e quantos CNPJs tem. */
export interface TierAllocationInput {
  regime: Regime;
  unitCents: number;
  quantity: number;
}

/** Pedaço de um regime que caiu dentro de uma faixa. */
export interface TierSlice {
  fromClients: number;
  /** `null` na última faixa, que é aberta. */
  toClients: number | null;
  label?: string;
  quantity: number;
  discountBps: number;
  unitCents: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
}

export interface TierAllocation {
  byRegime: ReadonlyMap<Regime, readonly TierSlice[]>;
  totalDiscountCents: number;
  /** Desconto efetivo sobre o bruto, em bps. Só para exibição. */
  effectiveDiscountBps: number;
}

export class TierScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierScheduleError';
  }
}

/** Teto de desconto marginal. Acima disso o modelo deixa de ser monotônico. */
export const MAX_TIER_DISCOUNT_BPS = 5000;

/**
 * Valida a escada. Falha alto de propósito: uma tabela inválida produziria
 * faturas erradas em silêncio, e o erro só apareceria como reembolso.
 */
export function assertValidSchedule(tiers: readonly PricingTier[]): void {
  if (tiers.length === 0) {
    return;
  }

  const ordered = [...tiers].sort((a, b) => a.fromClients - b.fromClients);

  if (ordered[0]!.fromClients !== 1) {
    throw new TierScheduleError(
      `A primeira faixa tem de começar em 1; começa em ${ordered[0]!.fromClients}. ` +
        'Sem isso há posições sem faixa, e o CNPJ que cair nelas não tem preço.',
    );
  }

  let anterior: PricingTier | undefined;
  for (const tier of ordered) {
    if (!Number.isInteger(tier.fromClients) || tier.fromClients < 1) {
      throw new TierScheduleError(`Início de faixa inválido: ${tier.fromClients}.`);
    }
    if (!Number.isInteger(tier.discountBps) || tier.discountBps < 0) {
      throw new TierScheduleError(`Desconto inválido na faixa ${tier.fromClients}.`);
    }
    if (tier.discountBps > MAX_TIER_DISCOUNT_BPS) {
      throw new TierScheduleError(
        `Faixa ${tier.fromClients} com ${tier.discountBps} bps excede o teto de ` +
          `${MAX_TIER_DISCOUNT_BPS} (50%). Acima de 50% o modelo marginal deixa de ser ` +
          'monotônico: acrescentar um CNPJ caro passaria a baixar a fatura. ' +
          'Degressão maior é caso de teto de fatura, não de faixa.',
      );
    }
    if (anterior) {
      if (tier.fromClients === anterior.fromClients) {
        throw new TierScheduleError(`Duas faixas começam em ${tier.fromClients}.`);
      }
      if (tier.discountBps < anterior.discountBps) {
        throw new TierScheduleError(
          `A faixa ${tier.fromClients} desconta menos que a faixa ${anterior.fromClients}. ` +
            'A escada tem de ser não-decrescente, senão crescer de carteira pode encarecer o CNPJ marginal.',
        );
      }
    }
    anterior = tier;
  }
}

interface TierRange {
  fromClients: number;
  toClients: number | null;
  discountBps: number;
  label?: string;
}

/**
 * Distribui os CNPJs pelas faixas e devolve as fatias por regime.
 *
 * Pura e sem I/O: é o número que vai na fatura, e precisa ser reproduzível fora
 * do banco — a mesma razão pela qual `quote()` é pura.
 */
export function allocateTiers(
  units: readonly TierAllocationInput[],
  tiers: readonly PricingTier[],
): TierAllocation {
  assertValidSchedule(tiers);

  const byRegime = new Map<Regime, readonly TierSlice[]>();

  const total = units.reduce((soma, unit) => soma + unit.quantity, 0);
  if (total === 0 || tiers.length === 0) {
    return { byRegime, totalDiscountCents: 0, effectiveDiscountBps: 0 };
  }

  const ranges = toRanges(tiers);

  // Decrescente por preço; o regime desempata para a alocação não depender da
  // ordem em que as linhas chegaram.
  const ordered = [...units]
    .filter((unit) => unit.quantity > 0)
    .sort((a, b) => b.unitCents - a.unitCents || a.regime.localeCompare(b.regime));

  let grossTotal = 0;
  let discountTotal = 0;
  // Posição 1-based da próxima unidade a alocar.
  let position = 1;

  for (const unit of ordered) {
    const slices: TierSlice[] = [];
    let restante = unit.quantity;

    for (const range of ranges) {
      if (restante === 0) {
        break;
      }
      // Quantas unidades deste regime caem nesta faixa.
      const fim = range.toClients ?? Number.POSITIVE_INFINITY;
      if (position > fim) {
        continue;
      }
      const disponivel = fim - Math.max(position, range.fromClients) + 1;
      if (disponivel <= 0) {
        continue;
      }
      const quantity = Math.min(restante, disponivel);

      const grossCents = unit.unitCents * quantity;
      // Arredondamento por **fatia**, nunca por unidade: arredondar o preço
      // unitário e multiplicar por 400 acumula centavos que não fecham com o
      // total, que é o tipo de divergência que o contador encontra e não perdoa.
      const discountCents = Math.round((grossCents * range.discountBps) / 10000);

      slices.push({
        fromClients: range.fromClients,
        toClients: range.toClients,
        ...(range.label === undefined ? {} : { label: range.label }),
        quantity,
        discountBps: range.discountBps,
        unitCents: unit.unitCents,
        grossCents,
        discountCents,
        netCents: grossCents - discountCents,
      });

      grossTotal += grossCents;
      discountTotal += discountCents;
      restante -= quantity;
      position += quantity;
    }

    byRegime.set(unit.regime, slices);
  }

  return {
    byRegime,
    totalDiscountCents: discountTotal,
    effectiveDiscountBps: grossTotal === 0 ? 0 : Math.round((discountTotal * 10000) / grossTotal),
  };
}

/** Converte a escada em intervalos fechados; a última faixa fica aberta. */
function toRanges(tiers: readonly PricingTier[]): TierRange[] {
  const ordered = [...tiers].sort((a, b) => a.fromClients - b.fromClients);

  return ordered.map((tier, index) => {
    const proxima = ordered[index + 1];
    return {
      fromClients: tier.fromClients,
      toClients: proxima ? proxima.fromClients - 1 : null,
      discountBps: tier.discountBps,
      ...(tier.label === undefined ? {} : { label: tier.label }),
    };
  });
}
