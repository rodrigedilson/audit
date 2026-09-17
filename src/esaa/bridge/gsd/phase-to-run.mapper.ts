import type { ESAAIntention, RunStartPayload, TaskCreatePayload } from '../../shared/types/esaa-event.types.js';
import { AGENT_TO_TASK_KIND, type TaskKind } from '../../shared/types/esaa-vocabulary.js';

export interface GSDPhase {
  id: string;
  name: string;
  objectives: string[];
  tasks: GSDTask[];
}

export interface GSDTask {
  id: string;
  description: string;
  assignee: string;
  dependencies?: string[];
}

export class PhaseToRunMapper {
  mapPhaseToIntentions(phase: GSDPhase): ESAAIntention[] {
    const intentions: ESAAIntention[] = [];
    const runId = `run-${phase.id}`;

    const runPayload: RunStartPayload = {
      run_id: runId,
      phase_name: phase.name,
      objectives: phase.objectives,
    };

    intentions.push({
      action: 'run.start',
      task_id: runId,
      actor: 'tech-lead',
      payload: runPayload as unknown as Record<string, unknown>,
    });

    for (const task of phase.tasks) {
      const kind: TaskKind = AGENT_TO_TASK_KIND[task.assignee] ?? 'impl';
      const taskPayload: TaskCreatePayload = {
        kind,
        description: task.description,
        assigned_agent: task.assignee,
        parent_run: runId,
        dependencies: task.dependencies,
      };

      intentions.push({
        action: 'task.create',
        task_id: `T-${task.id}`,
        actor: 'tech-lead',
        payload: taskPayload as unknown as Record<string, unknown>,
      });
    }

    return intentions;
  }

  inferTaskKind(assignee: string): TaskKind {
    return AGENT_TO_TASK_KIND[assignee] ?? 'impl';
  }
}
