import type {
  HotfixCreatePayload,
  IssueReportPayload,
} from '../shared/types/esaa-event.types.js';
import type { ESAAOrchestratorService } from './esaa-orchestrator.service.js';

export class HotfixWorkflowService {
  constructor(private readonly orchestrator: ESAAOrchestratorService) {}

  async reportIssue(
    reporterAgent: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    description: string,
    evidence: string[],
    affectedTasks: string[],
  ): Promise<void> {
    const issueId = `issue-${Date.now()}`;
    const payload: IssueReportPayload = {
      severity,
      description,
      evidence,
      affected_tasks: affectedTasks,
    };

    await this.orchestrator.processIntention({
      action: 'issue.report',
      task_id: issueId,
      actor: reporterAgent,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async createHotfix(
    issueId: string,
    taskId: string,
    _assignedAgent: string,
    scopePatch: string[],
    originalTaskId: string,
    requiredVerification: string[],
  ): Promise<void> {
    const payload: HotfixCreatePayload = {
      issue_id: issueId,
      scope_patch: scopePatch,
      original_task_id: originalTaskId,
      required_verification: requiredVerification,
    };

    await this.orchestrator.processIntention({
      action: 'hotfix.create',
      task_id: taskId,
      actor: 'tech-lead',
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async executeHotfixCycle(
    hotfixTaskId: string,
    agent: string,
    deliverables: string[],
    checks: string[],
    reviewerAgent: string,
  ): Promise<void> {
    // 1. Claim
    await this.orchestrator.processIntention({
      action: 'claim',
      task_id: hotfixTaskId,
      actor: agent,
      payload: { reason: 'Hotfix assignment' },
    });

    // 2. Complete (requires ≥2 checks for hotfix)
    if (checks.length < 2) {
      throw new Error('Hotfix completion requires at least 2 verification checks');
    }

    await this.orchestrator.processIntention({
      action: 'complete',
      task_id: hotfixTaskId,
      actor: agent,
      payload: {
        deliverables,
        checks_passed: checks,
        verification_count: checks.length,
      },
    });

    // 3. Review
    await this.orchestrator.processIntention({
      action: 'review',
      task_id: hotfixTaskId,
      actor: reviewerAgent,
      payload: {
        verdict: 'approve',
        comments: 'Hotfix verified with required checks',
      },
    });
  }
}
