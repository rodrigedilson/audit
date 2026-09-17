import type { ESAAIntention, FileUpdate } from '../../shared/types/esaa-event.types.js';
import type { ESAAAction } from '../../shared/types/esaa-vocabulary.js';

export class IntentionFormatterService {
  format(
    action: ESAAAction,
    taskId: string,
    actor: string,
    payload: Record<string, unknown>,
    fileUpdates?: FileUpdate[],
  ): ESAAIntention {
    return {
      action,
      task_id: taskId,
      actor: actor.toLowerCase().trim(),
      payload,
      file_updates: fileUpdates,
    };
  }

  formatClaim(taskId: string, actor: string, reason?: string): ESAAIntention {
    return this.format('claim', taskId, actor, { reason });
  }

  formatComplete(
    taskId: string,
    actor: string,
    deliverables: string[],
    checksPassed: string[],
    fileUpdates?: FileUpdate[],
  ): ESAAIntention {
    return this.format(
      'complete',
      taskId,
      actor,
      {
        deliverables,
        checks_passed: checksPassed,
        verification_count: checksPassed.length,
      },
      fileUpdates,
    );
  }

  formatReview(
    taskId: string,
    actor: string,
    verdict: 'approve' | 'request_changes',
    comments?: string,
  ): ESAAIntention {
    return this.format('review', taskId, actor, { verdict, comments });
  }

  formatIssueReport(
    taskId: string,
    actor: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    description: string,
    evidence: string[],
  ): ESAAIntention {
    return this.format('issue.report', taskId, actor, {
      severity,
      description,
      evidence,
      affected_tasks: [taskId],
    });
  }
}
