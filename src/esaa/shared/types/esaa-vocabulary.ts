export const AGENT_ACTIONS = ['claim', 'complete', 'review', 'issue.report'] as const;

export const ORCHESTRATOR_ACTIONS = [
  'run.start',
  'task.create',
  'hotfix.create',
  'output.rejected',
  'verify.start',
  'verify.ok',
  'verify.fail',
  'orchestrator.file.write',
  'phase.complete',
] as const;

export const ALL_ACTIONS = [...AGENT_ACTIONS, ...ORCHESTRATOR_ACTIONS] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];
export type ESAAAction = (typeof ALL_ACTIONS)[number];

export const TASK_STATES = ['todo', 'in_progress', 'review', 'done'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_KINDS = ['spec', 'impl', 'qa', 'review', 'hotfix', 'orchestrator'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const REJECTION_REASONS = [
  'unknown_action',
  'schema_violation',
  'boundary_violation',
  'immutable_done_violation',
  'lock_violation',
  'invalid_transition',
  'verification_mismatch',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  todo: ['in_progress'],
  in_progress: ['review'],
  review: ['done', 'in_progress'],
  done: [],
};

export const AGENT_TO_TASK_KIND: Record<string, TaskKind> = {
  'tech-lead': 'orchestrator',
  architect: 'spec',
  'docs-writer': 'spec',
  coder: 'impl',
  'devops-engineer': 'impl',
  tester: 'qa',
  'security-engineer': 'qa',
  'performance-engineer': 'qa',
  reviewer: 'review',
  debugger: 'hotfix',
};

export function isAgentAction(action: string): action is AgentAction {
  return (AGENT_ACTIONS as readonly string[]).includes(action);
}

export function isOrchestratorAction(action: string): action is OrchestratorAction {
  return (ORCHESTRATOR_ACTIONS as readonly string[]).includes(action);
}

export function isValidAction(action: string): action is ESAAAction {
  return (ALL_ACTIONS as readonly string[]).includes(action);
}

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
