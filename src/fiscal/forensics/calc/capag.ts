import type { CalculationStep } from './monetary.js';

/**
 * Capacidade de pagamento presumida (Capag-P), usada pela PGFN para definir o
 * desconto e o prazo que o contribuinte consegue numa transação tributária.
 *
 * É a peça de maior valor comercial do módulo: as variáveis saem de fontes que
 * o sistema já ingere — notas de saída, notas em que o contribuinte é
 * destinatário, pagamentos, retenções, receita bruta declarada — e o resultado
 * permite **contestar** a classificação atribuída, que é o que decide quanto de
 * desconto o cliente consegue.
 *
 * ## Os coeficientes não estão no código, e isso é deliberado
 *
 * Os pesos de cada variável vivem em tabela, que **nasce vazia**. Quem a
 * preenche é o buscador, lendo a página em que a PGFN publica a fórmula e
 * conferindo cada coeficiente, literal, no texto — e a PGFN muda a fórmula por
 * norma posterior. Fixar `0.3`, `0.1`, `0.8` aqui faria o sistema classificar a
 * capacidade de pagamento de um cliente, e a faixa de desconto que ele vai
 * pedir, com número que ninguém conferiu contra a fonte.
 *
 * Sem a fórmula carregada, `computeCapag` devolve `null` e o motivo — **nunca
 * zero**. Zero se leria como "sem capacidade de pagamento", que é uma
 * afirmação, e a mais favorável ao cliente: exatamente a que a PGFN contesta.
 */

export const CAPAG_GROUPS = [
  'pessoa_fisica',
  'pj_nao_simples',
  'pj_simples',
  'mei',
  /** Grupo 5 da PGFN: PJ nula, baixada, suspensa ou inapta. Fórmula própria, com V11. */
  'pj_inativa',
] as const;
export type CapagGroup = (typeof CAPAG_GROUPS)[number];

export interface CapagTerm {
  /** `V1`, `V2`… Identificador da variável na portaria. */
  variable: string;
  description: string;
  coefficient: number;
  /**
   * Em que bloco entra. O `multiplied` é somado e depois multiplicado pelo
   * fator de renda; o `added` entra direto no total.
   */
  block: 'multiplied' | 'added';
  /** Ordem significativa: V1, V2, … */
  ordinal: number;
  /** Substitui outra variável quando esta não existe. */
  substitutes: string | null;
  /** De onde o dado sai: declaração, sistema da PGFN, nota fiscal. */
  source: string;
}

export interface CapagFormula {
  group: CapagGroup;
  /** Multiplicador do bloco de rendimentos. Na fonte lida, 5. Não conferido. */
  incomeMultiplier: number;
  terms: readonly CapagTerm[];
  legalBasis: string;
  sourceRef: string | null;
  verified: boolean;
}

/** As quatro faixas da PGFN. Comparam a capacidade com a dívida total. */
export const CAPAG_BANDS = ['A', 'B', 'C', 'D'] as const;
export type CapagBand = (typeof CAPAG_BANDS)[number];

export interface CapagResult {
  /** Em centavos. `null` quando a fórmula não está carregada ou conferida. */
  capagCents: number | null;
  /** `capag / dívida total`. `null` pelo mesmo motivo. */
  coverage: number | null;
  /**
   * Faixa A–D. **Sempre `null` por enquanto**: a tabela que liga cobertura a
   * faixa é própria, também não conferida, e inferi-la produziria a
   * classificação sem base — que é o número que o cliente leva à PGFN.
   */
  band: CapagBand | null;
  /** Variáveis que a fórmula pede e a entrada não trouxe. */
  missingVariables: readonly string[];
  steps: readonly CalculationStep[];
  unavailableReason: string | null;
}

function indisponivel(reason: string, missing: readonly string[] = []): CapagResult {
  return {
    capagCents: null,
    coverage: null,
    band: null,
    missingVariables: missing,
    steps: [],
    unavailableReason: reason,
  };
}

/**
 * Aplica a fórmula do grupo sobre os valores informados.
 *
 * Variável ausente **não** vale zero em silêncio: entra em `missingVariables`,
 * e a tela mostra o que falta buscar. Tratá-la como zero produziria uma
 * capacidade menor que a real — favorável ao cliente, e por isso mesmo a
 * primeira coisa que a PGFN refaz.
 */
export function computeCapag(input: {
  formula: CapagFormula | null;
  /** Centavos por variável, chaveado por `V1`, `V2`… */
  values: Readonly<Record<string, number>>;
  totalDebtCents: number;
}): CapagResult {
  const { formula, values, totalDebtCents } = input;

  if (formula === null) {
    return indisponivel(
      'A fórmula da Capag-P não está carregada. Os coeficientes vêm da portaria ' +
        'da PGFN e não foram conferidos em texto oficial.',
    );
  }

  if (!formula.verified) {
    return indisponivel(
      `A fórmula do grupo '${formula.group}' está carregada e não foi conferida ` +
        'em texto oficial. Enquanto isso, o cálculo não afirma capacidade de pagamento.',
    );
  }

  if (formula.terms.length === 0) {
    return indisponivel(`A fórmula do grupo '${formula.group}' não tem variáveis.`);
  }

  const faltando = formula.terms
    .filter((t) => values[t.variable] === undefined && t.substitutes === null)
    .map((t) => t.variable);

  if (faltando.length > 0) {
    return indisponivel(
      `Faltam ${faltando.length} variável(is) que a fórmula exige: ${faltando.join(', ')}.`,
      faltando,
    );
  }

  const ordenados = [...formula.terms].sort((a, b) => a.ordinal - b.ordinal);
  const steps: CalculationStep[] = [];
  let bloco = 0;
  let somaDireta = 0;

  for (const termo of ordenados) {
    const valor = values[termo.variable] ?? 0;
    const parcela = valor * termo.coefficient;

    steps.push({
      label: `${termo.variable} — ${termo.description}`,
      expression: `${valor} × ${termo.coefficient}`,
      value: Math.round(parcela),
      unit: 'cents',
    });

    if (termo.block === 'multiplied') {
      bloco += parcela;
    } else {
      somaDireta += parcela;
    }
  }

  const capag = Math.round(bloco * formula.incomeMultiplier + somaDireta);

  steps.push({
    label: 'Bloco de rendimentos multiplicado',
    expression: `${Math.round(bloco)} × ${formula.incomeMultiplier}`,
    value: Math.round(bloco * formula.incomeMultiplier),
    unit: 'cents',
  });
  steps.push({
    label: 'Capacidade de pagamento presumida',
    expression: `${Math.round(bloco * formula.incomeMultiplier)} + ${Math.round(somaDireta)}`,
    value: capag,
    unit: 'cents',
  });

  return {
    capagCents: capag,
    // Dívida zero não é cobertura infinita: é ausência de dívida a classificar,
    // e a PGFN estima a capacidade mesmo de quem não deve.
    coverage: totalDebtCents > 0 ? capag / totalDebtCents : null,
    band: null,
    missingVariables: [],
    steps,
    unavailableReason: null,
  };
}
