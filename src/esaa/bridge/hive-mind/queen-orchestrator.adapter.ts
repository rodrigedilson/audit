import type { ESAAOrchestratorService } from '../../orchestrator/esaa-orchestrator.service.js';
import type { RunStartPayload, TaskCreatePayload } from '../../shared/types/esaa-event.types.js';
import type { TaskKind } from '../../shared/types/esaa-vocabulary.js';
import { AGENT_TO_TASK_KIND } from '../../shared/types/esaa-vocabulary.js';

export interface TaskDecomposition {
  phaseName: string;
  objectives: string[];
  tasks: Array<{
    taskId: string;
    description: string;
    assignedAgent: string;
    dependencies?: string[];
  }>;
}

export class QueenOrchestratorAdapter {
  constructor(private readonly orchestrator: ESAAOrchestratorService) {}

  async startRun(runId: string, phaseName: string, objectives: string[]): Promise<void> {
    const payload: RunStartPayload = {
      run_id: runId,
      phase_name: phaseName,
      objectives,
    };

    await this.orchestrator.processIntention({
      action: 'run.start',
      task_id: runId,
      actor: 'tech-lead',
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async decomposeAndAssign(decomposition: TaskDecomposition): Promise<void> {
    const runId = `run-${Date.now()}`;

    await this.startRun(runId, decomposition.phaseName, decomposition.objectives);

    for (const task of decomposition.tasks) {
      const kind: TaskKind = AGENT_TO_TASK_KIND[task.assignedAgent] ?? 'impl';
      const payload: TaskCreatePayload = {
        kind,
        description: task.description,
        assigned_agent: task.assignedAgent,
        parent_run: runId,
        dependencies: task.dependencies,
      };

      await this.orchestrator.processIntention({
        action: 'task.create',
        task_id: task.taskId,
        actor: 'tech-lead',
        payload: payload as unknown as Record<string, unknown>,
      });
    }
  }

  async verifyPhase(phaseName: string): Promise<{ valid: boolean }> {
    const verification = await this.orchestrator.verify();

    await this.orchestrator.processIntention({
      action: verification.valid ? 'verify.ok' : 'verify.fail',
      task_id: `verify-${phaseName}`,
      actor: 'tech-lead',
      payload: {
        status: verification.valid ? 'ok' : 'fail',
        event_count: verification.eventCount,
      },
    });

    return { valid: verification.valid };
  }
}
