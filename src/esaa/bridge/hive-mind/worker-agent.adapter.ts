import type { ESAAOrchestratorService, ProcessResult } from '../../orchestrator/esaa-orchestrator.service.js';
import type { CompletePayload, ClaimPayload } from '../../shared/types/esaa-event.types.js';

export class WorkerAgentAdapter {
  constructor(
    private readonly orchestrator: ESAAOrchestratorService,
    private readonly agentName: string,
  ) {}

  async claimTask(taskId: string, reason?: string): Promise<ProcessResult> {
    const payload: ClaimPayload = { reason };

    return this.orchestrator.processIntention({
      action: 'claim',
      task_id: taskId,
      actor: this.agentName,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async completeTask(
    taskId: string,
    deliverables: string[],
    checksPassed: string[],
  ): Promise<ProcessResult> {
    const payload: CompletePayload = {
      deliverables,
      checks_passed: checksPassed,
      verification_count: checksPassed.length,
    };

    return this.orchestrator.processIntention({
      action: 'complete',
      task_id: taskId,
      actor: this.agentName,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async reportIssue(
    taskId: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    description: string,
    evidence: string[],
  ): Promise<ProcessResult> {
    return this.orchestrator.processIntention({
      action: 'issue.report',
      task_id: taskId,
      actor: this.agentName,
      payload: {
        severity,
        description,
        evidence,
        affected_tasks: [taskId],
      },
    });
  }
}
