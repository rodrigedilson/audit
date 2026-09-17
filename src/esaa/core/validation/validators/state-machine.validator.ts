import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAIntention, MaterializedRoadmap } from '../../../shared/types/esaa-event.types.js';
import { StateTransitionService } from '../../task-machine/state-transition.service.js';
import type { ReviewPayload } from '../../../shared/types/esaa-event.types.js';

export class StateMachineValidator {
  readonly layer = 4;
  private readonly transitionService = new StateTransitionService();

  validate(intention: ESAAIntention, roadmap: MaterializedRoadmap): void {
    const taskActions = ['claim', 'complete', 'review'] as const;
    if (!(taskActions as readonly string[]).includes(intention.action)) {
      return;
    }

    const task = roadmap.tasks[intention.task_id];
    if (!task) {
      throw new ValidationError(
        this.layer,
        'invalid_transition',
        `Task '${intention.task_id}' not found in roadmap`,
      );
    }

    try {
      const verdict = intention.action === 'review'
        ? (intention.payload as unknown as ReviewPayload).verdict
        : undefined;
      this.transitionService.resolveTransition(
        intention.action,
        task.state,
        intention.task_id,
        verdict,
      );
    } catch {
      throw new ValidationError(
        this.layer,
        'invalid_transition',
        `Cannot perform '${intention.action}' on task '${intention.task_id}' in state '${task.state}'`,
      );
    }
  }
}
