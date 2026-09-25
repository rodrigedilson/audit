import type { Severity } from '../catalog/code-validation.js';

/**
 * Severidade por matriz probabilidade × impacto, em lugar de enum digitado.
 *
 * O `defaultSeverity` das trilhas do Book faz duas situações de custo muito
 * diferente entrarem com a mesma cor: "crédito sem documento hábil" numa nota de
 * R$ 80 e em quatro mil notas somando R$ 2 milhões saem iguais. A matriz é a
 * forma padrão de corrigir isso na gestão de risco do setor público, e é a
 * referência que a doutrina de perícia usa para dimensionar achado.
 *
 * **A probabilidade aqui é observada, não estimada** — e isso só é defensável
 * porque o padrão de execução é censo. Com a população inteira examinada, a
 * frequência de falha *é* a probabilidade naquele CNPJ e competência. Numa
 * amostra seria estimativa, e o achado obrigaria o contador a extrapolar, que é
 * o que o Fisco depois contesta.
 */

export const LIKELIHOOD_LEVELS = [1, 2, 3, 4, 5] as const;
export const IMPACT_LEVELS = [1, 2, 3, 4, 5] as const;

export type Likelihood = (typeof LIKELIHOOD_LEVELS)[number];
export type Impact = (typeof IMPACT_LEVELS)[number];

/** Faixas de `likelihood × impact` (1..25) para as quatro severidades. */
export const RISK_BANDS = [
  { maxScore: 4, severity: 'low' },
  { maxScore: 9, severity: 'medium' },
  { maxScore: 15, severity: 'high' },
  { maxScore: 25, severity: 'critical' },
] as const satisfies readonly { maxScore: number; severity: Severity }[];

/**
 * Frequência observada de falha → probabilidade.
 *
 * Limiares nossos, de priorização — não normativos. Mesma natureza dos
 * `LIMIARES_DE_GRAVIDADE` do calendário de prazos.
 */
export const LIKELIHOOD_BANDS = [
  { upToShare: 0.01, likelihood: 1 },
  { upToShare: 0.05, likelihood: 2 },
  { upToShare: 0.2, likelihood: 3 },
  { upToShare: 0.5, likelihood: 4 },
  { upToShare: null, likelihood: 5 },
] as const satisfies readonly { upToShare: number | null; likelihood: Likelihood }[];

/**
 * Impacto como **fração do débito da própria competência**, e não em reais.
 *
 * Adimensional de propósito: um piso em reais que faz sentido para um MEI é
 * ruído num Lucro Real, e um piso por regime exigiria uma tabela de valores em
 * BRL que ninguém conferiu.
 */
export const IMPACT_SHARE_BANDS = [
  { upToShare: 0.005, impact: 1 },
  { upToShare: 0.02, impact: 2 },
  { upToShare: 0.05, impact: 3 },
  { upToShare: 0.1, impact: 4 },
  { upToShare: null, impact: 5 },
] as const satisfies readonly { upToShare: number | null; impact: Impact }[];

export interface RiskAssessment {
  likelihood: Likelihood;
  impact: Impact;
  /** `likelihood × impact`, inteiro de 1 a 25. */
  score: number;
  severity: Severity;
  /**
   * O denominador da frequência, preservado. Sem ele o `likelihood` é um número
   * sem defesa: "5 de 5" e "5000 de 5000" produzem a mesma probabilidade e não
   * significam a mesma coisa para quem lê o Book.
   */
  observed: { failures: number; examined: number };
  /** Débito da competência usado como base do impacto relativo. */
  periodBaseCents: number;
}

export function scoreToSeverity(score: number): Severity {
  for (const faixa of RISK_BANDS) {
    if (score <= faixa.maxScore) {
      return faixa.severity;
    }
  }
  return 'critical';
}

/**
 * Nada examinado é probabilidade mínima, não média.
 *
 * Devolver 3 por não saber colocaria no meio da escala um risco sobre o qual
 * não há observação nenhuma — e a execução que não examinou nada já sai
 * inconclusiva por outro caminho.
 */
export function likelihoodFromFrequency(failures: number, examined: number): Likelihood {
  if (examined <= 0 || failures <= 0) {
    return 1;
  }

  const share = failures / examined;
  for (const faixa of LIKELIHOOD_BANDS) {
    if (faixa.upToShare === null || share <= faixa.upToShare) {
      return faixa.likelihood;
    }
  }
  return 5;
}

/**
 * Base zero com valor em risco positivo é impacto máximo: qualquer valor é
 * 100% de uma competência que não deve nada.
 */
export function impactFromShare(amountAtStakeCents: number, periodBaseCents: number): Impact {
  if (amountAtStakeCents <= 0) {
    return 1;
  }
  if (periodBaseCents <= 0) {
    return 5;
  }

  const share = amountAtStakeCents / periodBaseCents;
  for (const faixa of IMPACT_SHARE_BANDS) {
    if (faixa.upToShare === null || share <= faixa.upToShare) {
      return faixa.impact;
    }
  }
  return 5;
}

export function assess(input: {
  failures: number;
  examined: number;
  amountAtStakeCents: number;
  periodBaseCents: number;
}): RiskAssessment {
  const likelihood = likelihoodFromFrequency(input.failures, input.examined);
  const impact = impactFromShare(input.amountAtStakeCents, input.periodBaseCents);
  const score = likelihood * impact;

  return {
    likelihood,
    impact,
    score,
    severity: scoreToSeverity(score),
    observed: { failures: input.failures, examined: input.examined },
    periodBaseCents: input.periodBaseCents,
  };
}
