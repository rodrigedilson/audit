import type { ESAAIntention, CompletePayload, ClaimPayload, ReviewPayload } from '../../shared/types/esaa-event.types.js';
import type { GSDTask } from './phase-to-run.mapper.js';

export type GSDTaskStatus = 'pending' | 'in_progress' | 'completed' | 'verified';

export class TaskToESAATaskMapper {
  mapStatusChange(
    task: GSDTask,
    newStatus: GSDTaskStatus,
    details?: Record<string, unknown>,
  ): ESAAIntention | null {
    const taskId = `T-${task.id}`;

    switch (newStatus) {
      case 'in_progress':
        return {
          action: 'claim',
          task_id: taskId,
          actor: task.assignee,
          payload: { reason: 'GSD task assignment' } satisfies ClaimPayload as unknown as Record<string, unknown>,
        };

      case 'completed': {
        const completePayload: CompletePayload = {
          deliverables: (details?.deliverables as string[]) ?? [],
          checks_passed: (details?.checks as string[]) ?? [],
          verification_count: ((details?.checks as string[]) ?? []).length,
        };
        return {
          action: 'complete',
          task_id: taskId,
          actor: task.assignee,
          payload: completePayload as unknown as Record<string, unknown>,
        };
      }

      case 'verified': {
        const reviewPayload: ReviewPayload = {
          verdict: 'approve',
          comments: 'GSD verification passed',
        };
        return {
          action: 'review',
          task_id: taskId,
          actor: 'reviewer',
          payload: reviewPayload as unknown as Record<string, unknown>,
        };
      }

      default:
        return null;
    }
  }
}
