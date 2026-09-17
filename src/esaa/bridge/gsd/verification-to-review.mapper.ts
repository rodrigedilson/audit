import type { ESAAIntention, ReviewPayload } from '../../shared/types/esaa-event.types.js';

export interface GSDVerification {
  taskId: string;
  passed: boolean;
  comments?: string;
  issuesFound?: string[];
}

export class VerificationToReviewMapper {
  mapToReview(verification: GSDVerification, reviewerAgent: string): ESAAIntention {
    const payload: ReviewPayload = {
      verdict: verification.passed ? 'approve' : 'request_changes',
      comments: verification.comments,
      issues_found: verification.issuesFound,
    };

    return {
      action: 'review',
      task_id: `T-${verification.taskId}`,
      actor: reviewerAgent,
      payload: payload as unknown as Record<string, unknown>,
    };
  }
}
