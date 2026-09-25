import type { AppliedIndex } from './indices.js';

/**
 * Correção monetária e juros, com memória de cálculo.
 *
 * A doutrina separa as duas coisas, e o laudo tem de separar também: correção
 * monetária **repõe** o desgaste inflacionário e não remunera nada; juros
 * remuneram o capital ou punem a mora. Somá-las num número só impede a parte
 * contrária de impugnar uma sem a outra — e impede o juízo de acolher metade.
 *
 * Todo resultado vem com os passos que o produziram. Um valor sem memória de
 * cálculo é um valor que o perito não consegue defender em audiência.
 */

export const INTEREST_REGIMES = ['simples', 'composto'] as const;
export type InterestRegime = (typeof INTEREST_REGIMES)[number];

export interface CalculationStep {
  label: string;
  /** A conta, como vai impressa. */
  expression: string;
  /** Inteiro em centavos quando dinheiro; fração quando taxa ou fator. */
  value: number;
  unit: 'cents' | 'factor' | 'rate' | 'months';
}

export interface RestatementResult {
  /** `null` quando o índice não cobre o intervalo. Nunca o valor original. */
  restatedCents: number | null;
  /** Só a correção, separada do principal. */
  correctionCents: number | null;
  steps: readonly CalculationStep[];
  unavailableReason: string | null;
}

/**
 * Corrige um principal por um fator já apurado.
 *
 * Arredonda **uma vez, no fim**. Arredondar a cada mês acumularia meio centavo
 * por competência, e numa correção de seis anos a diferença aparece na conta
 * que a parte contrária refaz.
 */
export function restate(input: {
  principalCents: number;
  applied: AppliedIndex;
}): RestatementResult {
  const { principalCents, applied } = input;

  if (applied.factor === null) {
    return {
      restatedCents: null,
      correctionCents: null,
      steps: [],
      unavailableReason:
        applied.unavailableReason ?? `O índice '${applied.indexId}' não pôde ser apurado.`,
    };
  }

  const corrigido = Math.round(principalCents * applied.factor);

  return {
    restatedCents: corrigido,
    correctionCents: corrigido - principalCents,
    steps: [
      {
        label: 'Principal',
        expression: `${principalCents} centavos`,
        value: principalCents,
        unit: 'cents',
      },
      {
        label: `Fator acumulado ${applied.indexId} (${applied.from} → ${applied.to})`,
        expression: `${applied.months} competência(s), fonte ${applied.source}`,
        value: applied.factor,
        unit: 'factor',
      },
      {
        label: 'Valor corrigido',
        expression: `${principalCents} × ${applied.factor}`,
        value: corrigido,
        unit: 'cents',
      },
      {
        label: 'Correção monetária',
        expression: `${corrigido} − ${principalCents}`,
        value: corrigido - principalCents,
        unit: 'cents',
      },
    ],
    unavailableReason: null,
  };
}

export interface InterestResult {
  interestCents: number;
  totalCents: number;
  steps: readonly CalculationStep[];
}

/**
 * Juros sobre um principal.
 *
 * Simples aplica a taxa só sobre o capital inicial; composto aplica sobre o
 * capital somado aos juros já acumulados. A diferença cresce com o prazo, e
 * qual dos dois se aplica **não é escolha do perito**: vem da decisão, do
 * contrato ou da lei. Por isso o regime é parâmetro obrigatório e aparece na
 * memória — um laudo que não diz qual usou está pedindo impugnação.
 */
export function interest(input: {
  principalCents: number;
  /** Taxa mensal como fração: `0.01` é 1% ao mês. */
  ratePerMonth: number;
  months: number;
  regime: InterestRegime;
}): InterestResult {
  const { principalCents, ratePerMonth, months, regime } = input;

  const juros =
    regime === 'simples'
      ? Math.round(principalCents * ratePerMonth * months)
      : Math.round(principalCents * ((1 + ratePerMonth) ** months - 1));

  return {
    interestCents: juros,
    totalCents: principalCents + juros,
    steps: [
      {
        label: 'Principal',
        expression: `${principalCents} centavos`,
        value: principalCents,
        unit: 'cents',
      },
      {
        label: 'Taxa mensal',
        expression: `${(ratePerMonth * 100).toFixed(4)}% ao mês`,
        value: ratePerMonth,
        unit: 'rate',
      },
      { label: 'Prazo', expression: `${months} mês(es)`, value: months, unit: 'months' },
      {
        label: `Juros (${regime})`,
        expression:
          regime === 'simples'
            ? `${principalCents} × ${ratePerMonth} × ${months}`
            : `${principalCents} × ((1 + ${ratePerMonth})^${months} − 1)`,
        value: juros,
        unit: 'cents',
      },
      {
        label: 'Total',
        expression: `${principalCents} + ${juros}`,
        value: principalCents + juros,
        unit: 'cents',
      },
    ],
  };
}

export interface RestatedWithInterest {
  restatedCents: number | null;
  correctionCents: number | null;
  interestCents: number | null;
  totalCents: number | null;
  steps: readonly CalculationStep[];
  unavailableReason: string | null;
}

/**
 * Corrige e depois aplica juros — nesta ordem, e a ordem não é indiferente.
 *
 * Juros incidem sobre o valor **corrigido**: aplicá-los antes renderia menos,
 * porque a base seria o valor histórico. Inverter a ordem é um erro que só
 * aparece quando alguém refaz a conta.
 *
 * Os dois componentes continuam separados no resultado, para o laudo poder
 * discriminá-los e o juízo acolher um sem o outro.
 */
export function restateAndAccrue(input: {
  principalCents: number;
  applied: AppliedIndex;
  ratePerMonth: number;
  months: number;
  regime: InterestRegime;
}): RestatedWithInterest {
  const correcao = restate({ principalCents: input.principalCents, applied: input.applied });

  if (correcao.restatedCents === null) {
    return {
      restatedCents: null,
      correctionCents: null,
      interestCents: null,
      totalCents: null,
      steps: correcao.steps,
      unavailableReason: correcao.unavailableReason,
    };
  }

  const juros = interest({
    principalCents: correcao.restatedCents,
    ratePerMonth: input.ratePerMonth,
    months: input.months,
    regime: input.regime,
  });

  return {
    restatedCents: correcao.restatedCents,
    correctionCents: correcao.correctionCents,
    interestCents: juros.interestCents,
    totalCents: juros.totalCents,
    steps: [...correcao.steps, ...juros.steps.slice(1)],
    unavailableReason: null,
  };
}
