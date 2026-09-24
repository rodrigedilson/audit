/**
 * Caso pericial: o processo em que o escritório atua, e em que papel.
 *
 * O papel não é rótulo — ele determina o que pode ser emitido. A norma técnica
 * de perícia separa o **perito**, nomeado pelo juízo e obrigado à
 * imparcialidade, do **assistente técnico**, contratado por uma das partes para
 * defender o interesse dela. O primeiro emite laudo; o segundo, parecer.
 *
 * Confundir os dois é o pior erro possível neste módulo: entregar como
 * imparcial algo produzido para defender um lado destrói a peça e a
 * credibilidade de quem assinou.
 */

export const FORENSIC_ROLES = ['perito_nomeado', 'assistente_tecnico'] as const;
export type ForensicRole = (typeof FORENSIC_ROLES)[number];

export const CASE_STATES = [
  'nomeado',
  'proposta_apresentada',
  'diligencias_em_curso',
  'peca_em_elaboracao',
  'peca_entregue',
  /** Terminal. Esclarecimento abre peça nova vinculada, como a retificação. */
  'encerrado',
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const VALID_CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  nomeado: ['proposta_apresentada', 'diligencias_em_curso'],
  proposta_apresentada: ['diligencias_em_curso'],
  /** Autotransição: nova diligência é operação normal, não mudança de fase. */
  diligencias_em_curso: ['diligencias_em_curso', 'peca_em_elaboracao'],
  peca_em_elaboracao: ['diligencias_em_curso', 'peca_em_elaboracao', 'peca_entregue'],
  /** Volta para elaboração: impugnação e pedido de esclarecimento são a regra. */
  peca_entregue: ['peca_em_elaboracao', 'encerrado'],
  encerrado: [],
};

export function isValidCaseTransition(from: CaseState, to: CaseState): boolean {
  return VALID_CASE_TRANSITIONS[from].includes(to);
}

export const PARTY_ROLES = [
  'requerente',
  'requerida',
  'terceiro_interessado',
  'assistente',
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export interface ForensicParty {
  role: PartyRole;
  name: string;
  /** CPF (11) ou CNPJ (14), sem máscara. `null` quando não consta dos autos. */
  document: string | null;
  counsel: string | null;
}

export interface ForensicCase {
  caseId: string;
  /**
   * Numeração única do CNJ, 20 dígitos. Validada por **formato**, nunca por
   * consulta a tribunal: não há integração, e fingir que há faria o sistema
   * afirmar que o processo existe.
   */
  processNumber: string;
  court: string;
  jurisdiction: string;
  role: ForensicRole;
  /** CNPJ da carteira a que o caso se prende. É o que dá escopo e isolamento. */
  cnpj: string;
  parties: readonly ForensicParty[];
  /** Quem contratou. Obrigatório quando `assistente_tecnico`. */
  retainedBy: PartyRole | null;
  state: CaseState;
  appointedAt: string;
}

const NUMERO_CNJ = /^[0-9]{20}$/;

export function isValidProcessNumber(numero: string): boolean {
  return NUMERO_CNJ.test(numero);
}

/**
 * Perito nomeado emite laudo; assistente técnico emite parecer.
 *
 * A regra vive aqui, e não numa checagem de rota, porque é a mesma pergunta
 * feita em dois lugares: a tela precisa dela para desabilitar o botão, e o
 * portão de assinatura precisa dela para recusar.
 */
export function especieEsperada(role: ForensicRole): 'laudo' | 'parecer' {
  return role === 'perito_nomeado' ? 'laudo' : 'parecer';
}
