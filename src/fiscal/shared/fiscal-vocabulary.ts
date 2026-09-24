/**
 * Vocabulário controlado fiscal. A camada 3 do pipeline rejeita qualquer ação
 * fora daqui.
 *
 * Substitui o vocabulário de orquestração de agentes de software que o kernel
 * carregava (`run.start`, `task.create`, `claim`, `complete`, `review`). Aquele
 * domínio saiu junto do bridge Hive Mind/GSD: o produto é fiscal, e manter as
 * duas linguagens faria as 7 camadas validarem ações que o produto nunca emite.
 */

/**
 * Ações que um agente pode **propor**. Nenhuma delas escreve no log por conta
 * própria: passam pelo orquestrador, que decide. É o que se vende ao escritório
 * — nenhuma IA altera um número fiscal sozinha.
 */
export const AGENT_ACTIONS = [
  'item.classify',
  'issue.report',
  'assessment.review',
  'credit.flag',
] as const;

/** Ações que **efetivam** estado. Só o orquestrador as emite. */
export const ORCHESTRATOR_ACTIONS = [
  // portfolio/ — Onda 2
  'client.enrolled',
  'client.updated',
  'client.alert',
  'period.opened',
  'period.closed',
  'rectification.filed',
  'certificate.stored',
  'certificate.used',
  'certificate.removed',

  // ingestion/ — Onda 4
  'doc.received',
  'doc.manifested',
  // Cancelamento homologado pela SEFAZ (110111), trazido pela distribuição.
  'doc.cancelled',
  'sped.imported',
  'bank.statement.imported',

  // catalog/ — Onda 5
  'item.classified',
  'item.reclassified',

  // rules/ — Onda 6
  'rule.published',

  // assessment/ — Onda 6
  'assessment.projected',
  'assessment.adjusted',
  'assessment.confirmed',
  'fator_r.projected',
  'credit.recognized',
  'credit.conditioned',
  'credit.released',

  // reconciliation/ — Ondas 8 e 10
  'assessment.compared',
  'credit.at_risk',
  'credit.lost',
  'deadline.approaching',

  // reporting/ — Onda 7
  'book.generated',

  // Transversal: toda intenção barrada por uma das 7 camadas.
  'output.rejected',
] as const;

export const ALL_ACTIONS = [...AGENT_ACTIONS, ...ORCHESTRATOR_ACTIONS] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];
export type FiscalAction = (typeof ALL_ACTIONS)[number];

// ---------------------------------------------------------------- períodos
/** Estado da competência, por CNPJ. */
export const PERIOD_STATES = ['open', 'assessed', 'reconciled', 'confirmed'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

/**
 * `confirmed` é terminal (INV-001). Retificação **não** reabre o período: emite
 * `rectification.filed` e abre uma competência de retificação vinculada,
 * preservando o hash original — é o que permite ao escritório defender o número
 * que entregou, mesmo depois de corrigi-lo.
 */
export const VALID_PERIOD_TRANSITIONS: Record<PeriodState, readonly PeriodState[]> = {
  open: ['assessed'],
  /**
   * `assessed -> assessed` é permitido de propósito: reapurar depois de ingerir
   * mais documentos, e registrar ajuste antes da conciliação, são operações
   * normais do fechamento. Sem a autotransição, o contador teria de conciliar
   * uma apuração que ele sabe estar incompleta só para poder corrigi-la.
   */
  assessed: ['assessed', 'reconciled'],
  /**
   * `reconciled -> reconciled` é permitido pelo mesmo motivo que a autotransição
   * de `assessed`: o Fisco pode enviar proposta corrigida, e o upload pode ser
   * refeito depois de arrumar um erro de layout. Sem a autotransição, recomparar
   * exigiria reapurar a competência primeiro — voltando a `assessed` só para
   * poder aceitar o arquivo novo, o que registraria no log uma reapuração que
   * não aconteceu.
   */
  reconciled: ['assessed', 'reconciled', 'confirmed'],
  /** Terminal (INV-001): a correção é por retificação, em competência vinculada. */
  confirmed: [],
};

// ----------------------------------------------------------------- crédito
/**
 * `conditioned` = documento válido, mas o tributo da etapa anterior não foi
 * liquidado. `released` exige evidência de pagamento (split ou extrato).
 */
export const CREDIT_STATES = [
  'expected',
  'conditioned',
  'released',
  'at_risk',
  'lost',
] as const;
export type CreditState = (typeof CREDIT_STATES)[number];

export const VALID_CREDIT_TRANSITIONS: Record<CreditState, readonly CreditState[]> = {
  expected: ['conditioned'],
  conditioned: ['released', 'at_risk'],
  at_risk: ['released', 'lost'],
  released: [],
  lost: [],
};

// ------------------------------------------------------------------ regime
export const REGIMES = [
  'mei',
  'simples_integrado',
  'simples_hibrido',
  'lucro_presumido',
  'lucro_real',
] as const;
export type Regime = (typeof REGIMES)[number];

// -------------------------------------------------------------- rejeições
export const REJECTION_REASONS = [
  'schema_violation',
  /** Código fora das tabelas oficiais (NCM, CFOP, CST, cClassTrib, NBS). */
  'unknown_code',
  /** Combinação CST × cClassTrib × NCM inválida — o erro que a SEFAZ autoriza e a apuração pune. */
  'code_incompatible',
  'regime_violation',
  'closed_period_violation',
  'fisco_mismatch',
  'duplicate_document',
  'sequence_gap',
  'verification_mismatch',
  'boundary_violation',
  'invalid_transition',
  'tenant_violation',
  'lock_violation',
  'unknown_action',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

// -------------------------------------------------------------- agentes
/**
 * Cinco agentes fiscais, em lugar dos dez de engenharia. `reconciler` é
 * somente leitura: não escreve em lugar nenhum, e é o que alimenta o assistente
 * fiscal da Onda 9.
 */
export const AGENT_TASK_KINDS = ['spec', 'impl', 'qa', 'review', 'orchestrator'] as const;
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];

export const AGENT_TO_TASK_KIND: Record<string, AgentTaskKind> = {
  collector: 'impl',
  classifier: 'spec',
  auditor: 'qa',
  reconciler: 'review',
  closer: 'orchestrator',
};

/** O único agente que o orquestrador aceita como emissor de ação efetivadora. */
export const ORCHESTRATOR_AGENT = 'closer';

// ---------------------------------------------------------------- guardas
export function isAgentAction(action: string): action is AgentAction {
  return (AGENT_ACTIONS as readonly string[]).includes(action);
}

export function isOrchestratorAction(action: string): action is OrchestratorAction {
  return (ORCHESTRATOR_ACTIONS as readonly string[]).includes(action);
}

export function isValidAction(action: string): action is FiscalAction {
  return (ALL_ACTIONS as readonly string[]).includes(action);
}

export function isValidPeriodTransition(from: PeriodState, to: PeriodState): boolean {
  return VALID_PERIOD_TRANSITIONS[from].includes(to);
}

export function isValidCreditTransition(from: CreditState, to: CreditState): boolean {
  return VALID_CREDIT_TRANSITIONS[from].includes(to);
}

export function isKnownAgent(actor: string): boolean {
  return Object.hasOwn(AGENT_TO_TASK_KIND, actor);
}

/**
 * Um actor é um usuário quando parece um UUID — é o `sub` do JWT do Supabase.
 * Agentes têm nome. A distinção importa porque usuários agem através da API
 * (que é o orquestrador) e podem emitir ações efetivadoras; agentes só propõem.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserActor(actor: string): boolean {
  return UUID.test(actor);
}

/** Competência no formato `YYYY-MM`. */
const PERIOD_ID = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function isValidPeriodId(period: string): boolean {
  return PERIOD_ID.test(period);
}
