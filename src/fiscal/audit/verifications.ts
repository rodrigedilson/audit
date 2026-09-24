import type { CriterionRef } from '../shared/evaluation-criterion.js';

/**
 * As cinco verificações do teste de comprovação e inspeção documentária.
 *
 * A doutrina de perícia contábil formaliza o exame de um lançamento em cinco
 * conferências contra um critério. Passando nas cinco, há **evidência de
 * confiabilidade** e o lançamento vale. Falhando uma, há **distorção
 * relevante**, e o perito invalida e estorna o lançamento — gerando saldo
 * devedor para uma parte e credor para a outra. Na apuração fiscal as duas
 * partes são o contribuinte e o Fisco, e estornar um crédito de entrada é
 * exatamente isso.
 *
 * A ordem do array é significativa e é a ordem do teste: a primeira é
 * pré-requisito das demais. Um documento que não é fidedigno não tem data,
 * lançamento nem autorização a conferir.
 */
export const VERIFICATIONS = [
  'v1_fidedignidade_e_atores',
  'v2_data_documento_x_lancamento',
  'v3_lancamento_correto',
  'v4_autorizacao_competente',
  'v5_relacao_com_a_atividade',
] as const;

export type Verification = (typeof VERIFICATIONS)[number];

/** O que cada uma confere, traduzida do exame documental para o domínio fiscal. */
export const VERIFICATION_LABELS: Record<Verification, string> = {
  v1_fidedignidade_e_atores:
    'O documento é fidedigno e envolve os atores certos: chave de acesso válida, ' +
    'emitente e destinatário conferem com o CNPJ examinado.',
  v2_data_documento_x_lancamento:
    'A data do documento corresponde à competência em que foi apropriado — é aqui ' +
    'que aparece o crédito extemporâneo.',
  v3_lancamento_correto:
    'O lançamento foi feito corretamente: CFOP, CST, cClassTrib e NCM coerentes ' +
    'entre si e com a natureza da operação.',
  v4_autorizacao_competente:
    'A operação foi autorizada por quem podia: protocolo da SEFAZ presente, e o ' +
    'documento não foi cancelado nem denegado depois.',
  v5_relacao_com_a_atividade:
    'A operação guarda relação com a atividade do contribuinte — insumo gera ' +
    'crédito, uso e consumo não.',
};

/**
 * Três valores, e não booleano.
 *
 * O formulário da doutrina é sim/não porque o perito tem o documento na mão.
 * Este sistema rotineiramente **não pode** verificar: critério não conferido,
 * campo ausente no XML, manifestação que a ingestão ainda não coleta. Um
 * booleano transformaria "não sei" em "passou", e cinco "passou" viram evidência
 * de confiabilidade — a afirmação mais cara que este módulo pode fazer errada.
 *
 * É a mesma escolha que `audit-trails.ts` já fez ao separar `not_applicable` de
 * `passed` quando a tabela oficial não está carregada.
 */
export const VERIFICATION_OUTCOMES = ['pass', 'fail', 'not_verified'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/** Uma comparação concreta entre o documento e o critério. É a prova do exame. */
export interface ComparedField {
  /** Caminho no documento: `emit.CNPJ`, `ide.dhEmi`, `det.imposto.CST`. */
  field: string;
  documentValue: string;
  /** `null` quando o critério fixa forma, e não valor. */
  criterionValue: string | null;
  matches: boolean;
}

export interface VerificationResult {
  verification: Verification;
  outcome: VerificationOutcome;
  /**
   * Por que passou, falhou ou não pôde ser verificada — numa frase que o
   * contador leva ao cliente. Nunca vazia: verificação muda não explica nada.
   */
  rationale: string;
  /** As comparações feitas. Ordem significativa. */
  compared: readonly ComparedField[];
  /** Contra o quê se conferiu. Ausente só quando a verificação não rodou. */
  criterion?: CriterionRef;
}

/**
 * Evidência de confiabilidade: as cinco em `pass`.
 *
 * Um `not_verified` no meio **não basta**, e é esse o ponto. Quatro conferidas e
 * uma ignorada não é um lançamento conferido.
 */
export function isReliable(results: readonly VerificationResult[]): boolean {
  return (
    results.length === VERIFICATIONS.length && results.every((r) => r.outcome === 'pass')
  );
}

/** Distorção relevante: alguma em `fail`. Preserva a ordem de `VERIFICATIONS`. */
export function failedVerifications(
  results: readonly VerificationResult[],
): Verification[] {
  const falhas = new Set(results.filter((r) => r.outcome === 'fail').map((r) => r.verification));

  return VERIFICATIONS.filter((v) => falhas.has(v));
}

/**
 * O teste não concluiu: alguma verificação não pôde ser feita.
 *
 * Inconclusivo bloqueia estorno. Invalidar um lançamento com base num exame que
 * não terminou seria afirmar a distorção sem tê-la comprovado.
 */
export function isInconclusive(results: readonly VerificationResult[]): boolean {
  return (
    results.length < VERIFICATIONS.length || results.some((r) => r.outcome === 'not_verified')
  );
}

/** Conclusão do teste sobre um lançamento. */
export type TestOutcome = 'confiavel' | 'distorcao_relevante' | 'inconclusivo';

/**
 * A ordem das perguntas importa: falha é conclusão, e prevalece sobre
 * inconclusivo. Um documento cancelado com crédito apropriado é distorção
 * mesmo que a verificação 5 não tenha podido rodar — a falha já está provada, e
 * esperar pelo resto adiaria um achado que se sustenta sozinho.
 */
export function conclude(results: readonly VerificationResult[]): TestOutcome {
  if (failedVerifications(results).length > 0) {
    return 'distorcao_relevante';
  }
  return isInconclusive(results) ? 'inconclusivo' : 'confiavel';
}
