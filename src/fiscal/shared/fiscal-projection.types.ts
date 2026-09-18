import type { CreditState, PeriodState, Regime } from './fiscal-vocabulary.js';

/**
 * Projeção de um CNPJ: o estado atual derivado do event log daquele par
 * (tenant, CNPJ). Substitui o `MaterializedRoadmap` de tasks e runs do domínio
 * de orquestração de agentes.
 *
 * `tenant_id` e `cnpj` entram no objeto **hasheado** de propósito: amarram o
 * hash ao escopo, então uma projeção do CNPJ A não pode ser apresentada como
 * prova do CNPJ B nem que os dois tenham o mesmo conteúdo.
 */
export interface FiscalProjection {
  schema_version: string;
  projection_hash_sha256: string;
  last_event_seq: number;
  last_updated: string;
  tenant_id: string;
  cnpj: string;
  client: ClientProjection | null;
  /** Chaveado por competência `YYYY-MM`. */
  periods: Record<string, PeriodProjection>;
  certificate: CertificateProjection | null;
  alerts: ClientAlert[];
  issues: FiscalIssue[];
  stats: FiscalStats;
}

export interface ClientProjection {
  legal_name: string;
  trade_name?: string;
  regime: Regime;
  /** Competência a partir da qual o regime vale. O regime muda com vigência. */
  regime_effective_from?: string;
  uf?: string;
  municipality_ibge?: string;
  cnae_primary?: string;
  status: 'active' | 'inactive';
  enrolled_at: string;
  enrolled_by: string;
}

export interface PeriodProjection {
  period: string;
  state: PeriodState;
  opened_at: string;
  /** Hash da projeção no instante da confirmação. Preservado mesmo após retificação. */
  projection_hash?: string;
  confirmed_at?: string;
  confirmed_by?: string;
  closed_at?: string;
  /**
   * Quando esta competência é uma retificação, aponta para a original. A
   * original nunca é alterada: INV-001.
   */
  rectifies?: string;
  /** Competência de retificação que corrige esta, se houver. */
  rectified_by?: string;
}

export interface CertificateProjection {
  subject: string;
  issuer: string;
  serial: string;
  valid_from: string;
  valid_to: string;
  stored_at: string;
  stored_by: string;
  last_used_at?: string;
  usage_count: number;
}

export interface ClientAlert {
  alert_id: string;
  kind: 'cnae_impeditivo' | 'risco_exclusao_simples' | 'certificado_vencendo' | 'outro';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  raised_at: string;
}

export interface FiscalIssue {
  issue_id: string;
  /** Camada do pipeline que detectou (1 parse … 7 verification-gate). */
  layer: number;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  period?: string;
  access_key?: string;
  status: 'open' | 'resolved';
  raised_at: string;
}

export interface FiscalStats {
  periods_total: number;
  periods_open: number;
  periods_assessed: number;
  periods_reconciled: number;
  periods_confirmed: number;
  documents_received: number;
  items_classified: number;
  credits_by_state: Record<CreditState, number>;
  open_issues: number;
  rejected_count: number;
  certificate_uses: number;
}

// ------------------------------------------------------------- payloads
/** Payloads das ações de `portfolio/`. Os demais contexts acrescentam os seus. */

export interface ClientEnrolledPayload {
  legal_name: string;
  trade_name?: string;
  regime: Regime;
  uf?: string;
  municipality_ibge?: string;
  cnae_primary?: string;
}

export interface ClientUpdatedPayload {
  trade_name?: string;
  regime?: Regime;
  regime_effective_from?: string;
  status?: 'active' | 'inactive';
}

export interface PeriodOpenedPayload {
  period: string;
  /** Preenchido quando a competência é de retificação. */
  rectifies?: string;
}

export interface PeriodClosedPayload {
  period: string;
  projection_hash: string;
}

export interface RectificationFiledPayload {
  /** Competência original, que permanece imutável. */
  original_period: string;
  /** Competência de retificação aberta em seguida. */
  rectification_period: string;
  reason: string;
  original_projection_hash: string;
}

export interface CertificateStoredPayload {
  subject: string;
  issuer: string;
  serial: string;
  valid_from: string;
  valid_to: string;
}

export interface CertificateUsedPayload {
  purpose: 'dfe_distribution' | 'nfse_query' | 'manifestation' | 'sped_transmission' | 'other';
  target: string;
  outcome: 'success' | 'failure';
  ip?: string;
}

export interface ClientAlertPayload {
  alert_id: string;
  kind: ClientAlert['kind'];
  severity: ClientAlert['severity'];
  message: string;
}

export interface OutputRejectedPayload {
  reason: string;
  details: string;
  original_action: string;
  validation_layer: number;
}

export interface AssessmentConfirmedPayload {
  period: string;
  projection_hash: string;
}

export type FiscalPayload = Record<string, unknown>;

/** Uma intenção: o que o chamador pede. Vira evento só se as 7 camadas deixarem. */
export interface FiscalIntention {
  action: string;
  /**
   * Entidade alvo: competência, chave de acesso, item ou o próprio CNPJ. Herda o
   * nome `task_id` do envelope de evento por compatibilidade do log.
   */
  task_id: string;
  actor: string;
  payload: FiscalPayload;
  period?: string;
}
