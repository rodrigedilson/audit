import type { ESAAAction, TaskKind, TaskState, RejectionReason } from './esaa-vocabulary.js';

export interface ESAAEventData {
  event_id: string;
  /**
   * Monotônico e sem gaps **dentro** do par (tenant_id, cnpj), não global.
   * Ver ADR-003.
   */
  event_seq: number;
  action: ESAAAction;
  task_id: string;
  actor: string;
  ts: string;
  schema_version: string;
  /** Escritório dono do evento. Campo de primeira classe, não payload (ADR-002). */
  tenant_id: string;
  /** CNPJ do cliente, 14 dígitos sem máscara. */
  cnpj: string;
  /**
   * Competência `YYYY-MM`, quando o evento pertence a uma. Opcional de propósito:
   * `client.enrolled` e `certificate.stored` são do CNPJ, não de um mês.
   */
  period?: string;
  payload: ESAAPayload;
}

export type ESAAPayload =
  | RunStartPayload
  | TaskCreatePayload
  | ClaimPayload
  | CompletePayload
  | ReviewPayload
  | IssueReportPayload
  | HotfixCreatePayload
  | OutputRejectedPayload
  | VerifyPayload
  | FileWritePayload
  | PhaseCompletePayload;

export interface RunStartPayload {
  run_id: string;
  phase_name: string;
  objectives: string[];
  baseline_hash?: string;
}

export interface TaskCreatePayload {
  kind: TaskKind;
  description: string;
  assigned_agent: string;
  parent_run: string;
  dependencies?: string[];
}

export interface ClaimPayload {
  reason?: string;
}

export interface CompletePayload {
  deliverables: string[];
  checks_passed: string[];
  verification_count: number;
}

export interface ReviewPayload {
  verdict: 'approve' | 'request_changes';
  comments?: string;
  issues_found?: string[];
}

export interface IssueReportPayload {
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string[];
  affected_tasks: string[];
}

export interface HotfixCreatePayload {
  issue_id: string;
  scope_patch: string[];
  original_task_id: string;
  required_verification: string[];
}

export interface OutputRejectedPayload {
  reason: RejectionReason;
  details: string;
  original_action: string;
  validation_layer: number;
}

export interface VerifyPayload {
  status?: 'ok' | 'fail' | 'mismatch' | 'corrupted';
  projection_hash?: string;
  replay_hash?: string;
  event_count?: number;
}

export interface FileWritePayload {
  path: string;
  content_hash: string;
  size_bytes: number;
}

export interface PhaseCompletePayload {
  phase_name: string;
  tasks_completed: number;
  tasks_total: number;
  verification_status: 'ok' | 'fail';
}

export interface ESAAIntention {
  action: ESAAAction;
  task_id: string;
  actor: string;
  payload: Record<string, unknown>;
  file_updates?: FileUpdate[];
  /**
   * Competência a que a intenção se refere. O tenant e o CNPJ não vêm aqui: são
   * do escopo do orquestrador, e deixá-los na intenção permitiria a um cliente
   * pedir escrita no log de outro escritório. Ver ADR-002.
   */
  period?: string;
}

export interface FileUpdate {
  path: string;
  content: string;
}

export interface MaterializedTask {
  task_id: string;
  kind: TaskKind;
  description: string;
  state: TaskState;
  assigned_agent: string;
  parent_run: string;
  dependencies: string[];
  created_at: string;
  updated_at: string;
  claimed_at?: string;
  completed_at?: string;
  reviewed_at?: string;
  deliverables: string[];
  checks_passed: string[];
  is_hotfix: boolean;
  issue_id?: string;
  scope_patch?: string[];
}

export interface MaterializedRoadmap {
  schema_version: string;
  projection_hash_sha256: string;
  last_event_seq: number;
  last_updated: string;
  run: {
    run_id: string;
    phase_name: string;
    status: 'active' | 'completed' | 'failed';
    objectives: string[];
    started_at: string;
  } | null;
  tasks: Record<string, MaterializedTask>;
  issues: ESAAIssue[];
  stats: {
    total: number;
    todo: number;
    in_progress: number;
    review: number;
    done: number;
    rejected_count: number;
  };
}

export interface ESAAIssue {
  issue_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string[];
  affected_tasks: string[];
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at?: string;
  hotfix_task_id?: string;
}
