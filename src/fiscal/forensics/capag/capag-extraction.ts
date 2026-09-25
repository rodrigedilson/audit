import {
  CAPAG_BANDS,
  CAPAG_GROUPS,
  computeCapag,
  type CapagBand,
  type CapagFormula,
  type CapagGroup,
  type CapagTerm,
} from '../calc/capag.js';

/**
 * O que o extrator devolve, e a conferência que decide se vale.
 *
 * **O modelo propõe, o código decide.** Todo número vem com o trecho literal do
 * documento de onde saiu (`quote`) e com o número como está impresso
 * (`printed`). A conferência exige as duas coisas: o trecho está no texto, e o
 * número está no trecho. O valor usado no cálculo é lido do `printed` pelo
 * código, e não pelo modelo — um "1.234.567,89" que o modelo transcreveu como
 * 123456789 seria erro de cem vezes, e aqui ele não tem como acontecer.
 */

/** Um número citado: como está impresso, e o trecho que o contém. */
export interface Cited {
  printed: string;
  quote: string;
}

export const DOCUMENT_KINDS = ['demonstrativo_regularize', 'norma_ou_doutrina', 'outro'] as const;
export type ExtractionDocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface ExtractedTerm {
  /** `V1`, `V2`… como o documento chama. */
  variable: string;
  description: string;
  coefficient: Cited;
  block: 'multiplied' | 'added';
  /** Variável que esta substitui quando ausente, se o documento diz. */
  substitutes: string | null;
  /** De onde o documento diz que o dado sai (ECF, PGDAS-D, nota fiscal…). */
  source: string;
}

export interface CapagExtraction {
  documentKind: ExtractionDocumentKind;
  group: CapagGroup | null;
  /** Data de referência do cálculo, como impressa. */
  referenceDate: Cited | null;
  /** Norma que o documento cita como base. */
  legalBasis: string | null;
  formula: { incomeMultiplier: Cited | null; terms: ExtractedTerm[] } | null;
  /**
   * Uma fórmula por grupo, quando o texto descreve mais de uma — a página
   * oficial da PGFN traz pessoa física, PJ fora do Simples e PJ do Simples
   * juntas. No demonstrativo, que é de um contribuinte só, fica vazia.
   */
  formulas: { group: CapagGroup; incomeMultiplier: Cited | null; terms: ExtractedTerm[] }[];
  /** Valor de cada variável neste CNPJ. Só existe no demonstrativo. */
  values: { variable: string; amount: Cited }[];
  capag: Cited | null;
  totalDebt: Cited | null;
  band: { value: CapagBand; quote: string } | null;
}

/** JSON Schema da saída estruturada. Sem restrição numérica nem de tamanho: a API não as aceita. */
const CITED = {
  type: 'object',
  additionalProperties: false,
  required: ['printed', 'quote'],
  properties: { printed: { type: 'string' }, quote: { type: 'string' } },
} as const;
const CITED_OU_NULO = { anyOf: [CITED, { type: 'null' }] } as const;

const TERMO = {
  type: 'object',
  additionalProperties: false,
  required: ['variable', 'description', 'coefficient', 'block', 'substitutes', 'source'],
  properties: {
    variable: { type: 'string' },
    description: { type: 'string' },
    coefficient: CITED,
    block: { type: 'string', enum: ['multiplied', 'added'] },
    substitutes: { type: ['string', 'null'] },
    source: { type: 'string' },
  },
} as const;

export const CAPAG_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['documentKind', 'group', 'referenceDate', 'legalBasis', 'formula', 'formulas', 'values', 'capag', 'totalDebt', 'band'],
  properties: {
    documentKind: { type: 'string', enum: [...DOCUMENT_KINDS] },
    group: { anyOf: [{ type: 'string', enum: [...CAPAG_GROUPS] }, { type: 'null' }] },
    referenceDate: CITED_OU_NULO,
    legalBasis: { type: ['string', 'null'] },
    formula: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['incomeMultiplier', 'terms'],
          properties: {
            incomeMultiplier: CITED_OU_NULO,
            terms: { type: 'array', items: TERMO },
          },
        },
        { type: 'null' },
      ],
    },
    formulas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'incomeMultiplier', 'terms'],
        properties: {
          group: { type: 'string', enum: [...CAPAG_GROUPS] },
          incomeMultiplier: CITED_OU_NULO,
          terms: { type: 'array', items: TERMO },
        },
      },
    },
    values: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['variable', 'amount'],
        properties: { variable: { type: 'string' }, amount: CITED },
      },
    },
    capag: CITED_OU_NULO,
    totalDebt: CITED_OU_NULO,
    band: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['value', 'quote'],
          properties: { value: { type: 'string', enum: [...CAPAG_BANDS] }, quote: { type: 'string' } },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

// ------------------------------------------------------------ conferência

/** Espaço, quebra de linha e NBSP viram um espaço: o PDF quebra linha onde quer. */
export function normalizar(texto: string): string {
  return texto.normalize('NFC').replace(/[\s  ]+/g, ' ').trim();
}

/** `R$ 1.234.567,89`, `-R$ 10,00`, `(10,00)` → centavos. `null` quando não é dinheiro. */
export function lerDinheiro(impresso: string): number | null {
  const t = impresso.replace(/[\s ]/g, '');
  const negativo = /^-|^\(.*\)$/.test(t);
  const m = /^\(?-?(?:R\$)?-?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\)?$/.exec(t);
  if (m === null) return null;
  const inteiro = Number(m[1]!.replace(/\./g, ''));
  const centavos = Number((m[2] ?? '0').padEnd(2, '0'));
  return (negativo ? -1 : 1) * (inteiro * 100 + centavos);
}

/**
 * `0,10`, `0.10`, `10%`, `10,5 %`, `5`, `5x` → número (percentual vira fração).
 *
 * Coeficiente aceita ponto decimal: é como a própria PGFN imprime a fórmula na
 * página oficial (`5(0.3V1 + 0.1V2 + V3)`). Dinheiro, não — em reais o ponto é
 * separador de milhar, e `lerDinheiro` continua só no formato brasileiro.
 */
export function lerNumero(impresso: string): number | null {
  const t = impresso.replace(/[\s ]/g, '').replace(/[x×]$/i, '');
  const pct = t.endsWith('%');
  const corpo = pct ? t.slice(0, -1) : t;
  if (!/^-?\d+([,.]\d+)?$/.test(corpo)) return null;
  const n = Number(corpo.replace(',', '.'));
  return pct ? Number((n / 100).toFixed(10)) : n;
}

/** `dd/mm/aaaa` → `aaaa-mm-dd`. */
export function lerData(impresso: string): string | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(impresso);
  return m === null ? null : `${m[3]}-${m[2]}-${m[1]}`;
}

export interface CapagCheck {
  /** Fórmula lida e conferida trecho a trecho. `verified` só quando reproduz. */
  formula: CapagFormula | null;
  valuesCents: Record<string, number>;
  printedCapagCents: number | null;
  totalDebtCents: number | null;
  band: CapagBand | null;
  referenceDate: string | null;
  computedCapagCents: number | null;
  /** O cálculo com a fórmula e os valores extraídos chega à CAPAG impressa. */
  reproduces: boolean;
  verified: boolean;
  /** Tudo o que impediu a conferência, em frases para a tela. */
  problems: string[];
}

/** Diferença tolerada entre a CAPAG calculada e a impressa: R$ 1, por arredondamento. */
const TOLERANCIA_CENTAVOS = 100;

/**
 * Confere a extração contra o texto do documento.
 *
 * `reproduz` exige fórmula, valores, CAPAG impressa e **nenhum** trecho que
 * falhou. A série fica conferida só quando reproduz: é a conferência
 * automática "quando as fontes batem", com a fonte sendo o próprio
 * demonstrativo — a fórmula dele, aplicada aos valores dele, chega ao número
 * dele. A fórmula de referência tem conferência própria, no buscador: conferida
 * só a da página oficial da PGFN, e a de doutrina nunca.
 */
export function conferirExtracao(extracao: CapagExtraction, textoDoDocumento: string): CapagCheck {
  const texto = normalizar(textoDoDocumento);
  const problems: string[] = [];

  const citado = (c: Cited | null, onde: string): Cited | null => {
    if (c === null) return null;
    const trecho = normalizar(c.quote);
    if (trecho === '' || !texto.includes(trecho)) {
      problems.push(`${onde}: o trecho citado não está no documento ("${c.quote.slice(0, 80)}").`);
      return null;
    }
    if (!trecho.includes(normalizar(c.printed))) {
      problems.push(`${onde}: o número "${c.printed}" não está no trecho citado.`);
      return null;
    }
    return c;
  };

  const dinheiro = (c: Cited | null, onde: string): number | null => {
    const ok = citado(c, onde);
    if (ok === null) return null;
    const v = lerDinheiro(ok.printed);
    if (v === null) problems.push(`${onde}: "${ok.printed}" não é um valor em reais.`);
    return v;
  };

  let formula: CapagFormula | null = null;
  if (extracao.formula !== null) {
    const multiplicadorCitado = citado(extracao.formula.incomeMultiplier, 'Multiplicador do bloco de rendimentos');
    const multiplicador = multiplicadorCitado === null ? null : lerNumero(multiplicadorCitado.printed);
    if (extracao.formula.incomeMultiplier !== null && multiplicadorCitado !== null && multiplicador === null) {
      problems.push(`Multiplicador: "${multiplicadorCitado.printed}" não é um número.`);
    }

    const termos: CapagTerm[] = [];
    extracao.formula.terms.forEach((t, i) => {
      // Coeficiente implícito (`+ V8`): não há número impresso a citar, e o
      // trecho tem de conter a própria variável.
      if (t.coefficient.printed.trim() === '') {
        const trecho = normalizar(t.coefficient.quote);
        if (trecho === '' || !texto.includes(trecho) || !trecho.includes(t.variable)) {
          problems.push(`Coeficiente implícito de ${t.variable}: o trecho citado não está no documento ou não traz a variável.`);
          return;
        }
        termos.push({
          variable: t.variable,
          description: t.description,
          coefficient: 1,
          block: t.block,
          ordinal: i + 1,
          substitutes: t.substitutes,
          source: t.source,
        });
        return;
      }
      const coefCitado = citado(t.coefficient, `Coeficiente de ${t.variable}`);
      const coef = coefCitado === null ? null : lerNumero(coefCitado.printed);
      if (coefCitado !== null && coef === null) {
        problems.push(`Coeficiente de ${t.variable}: "${coefCitado.printed}" não é um número.`);
      }
      if (coef !== null) {
        termos.push({
          variable: t.variable,
          description: t.description,
          coefficient: coef,
          block: t.block,
          ordinal: i + 1,
          substitutes: t.substitutes,
          source: t.source,
        });
      }
    });

    if (extracao.formula.terms.length === 0) problems.push('A fórmula extraída não tem variáveis.');
    if (extracao.group === null) problems.push('O documento não identifica o grupo do contribuinte.');

    formula = {
      group: extracao.group ?? 'pj_nao_simples',
      incomeMultiplier: multiplicador ?? 1,
      terms: termos,
      legalBasis: extracao.legalBasis ?? '',
      sourceRef: null,
      verified: false,
    };
    if (extracao.formula.incomeMultiplier === null) {
      problems.push('O documento não traz o multiplicador do bloco de rendimentos.');
    }
  }

  const valuesCents: Record<string, number> = {};
  for (const v of extracao.values) {
    const cents = dinheiro(v.amount, `Valor de ${v.variable}`);
    if (cents !== null) valuesCents[v.variable] = cents;
  }

  const printedCapagCents = dinheiro(extracao.capag, 'CAPAG impressa');
  const totalDebtCents = dinheiro(extracao.totalDebt, 'Dívida total');

  let band: CapagBand | null = null;
  if (extracao.band !== null) {
    const trecho = normalizar(extracao.band.quote);
    if (trecho === '' || !texto.includes(trecho)) {
      problems.push('Classificação: o trecho citado não está no documento.');
    } else if (!new RegExp(`\\b${extracao.band.value}\\b`).test(trecho)) {
      problems.push(`Classificação: a faixa "${extracao.band.value}" não está no trecho citado.`);
    } else {
      band = extracao.band.value;
    }
  }

  const dataCitada = citado(extracao.referenceDate, 'Data de referência');
  const referenceDate = dataCitada === null ? null : lerData(dataCitada.printed);

  // Reprodução: com a fórmula tratada como conferida só para a conta. Se a
  // conta não chegar à CAPAG impressa, nada é afirmado.
  let computedCapagCents: number | null = null;
  let reproduces = false;
  const podeReproduzir =
    extracao.documentKind === 'demonstrativo_regularize' &&
    formula !== null &&
    printedCapagCents !== null &&
    problems.length === 0;
  if (podeReproduzir) {
    const r = computeCapag({ formula: { ...formula!, verified: true }, values: valuesCents, totalDebtCents: totalDebtCents ?? 0 });
    computedCapagCents = r.capagCents;
    if (r.capagCents === null) {
      problems.push(`A fórmula extraída não fecha: ${r.unavailableReason}`);
    } else if (Math.abs(r.capagCents - printedCapagCents!) > TOLERANCIA_CENTAVOS) {
      problems.push(
        `A fórmula e os valores extraídos dão ${formatar(r.capagCents)}, e o demonstrativo diz ${formatar(printedCapagCents!)}.`,
      );
    } else {
      reproduces = true;
    }
  } else if (extracao.documentKind === 'demonstrativo_regularize' && printedCapagCents === null && problems.length === 0) {
    problems.push('O demonstrativo não traz a CAPAG apurada para conferir a conta.');
  }

  const verified = reproduces && problems.length === 0;
  return {
    formula: formula === null ? null : { ...formula, verified },
    valuesCents,
    printedCapagCents,
    totalDebtCents,
    band,
    referenceDate,
    computedCapagCents,
    reproduces,
    verified,
    problems,
  };
}

function formatar(centavos: number): string {
  // Espaço comum no lugar do inseparável que o `Intl` põe depois do R$.
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
}
