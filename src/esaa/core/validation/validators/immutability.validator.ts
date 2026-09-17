import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAIntention, MaterializedRoadmap } from '../../../shared/types/esaa-event.types.js';
import { ImmutabilityGuardService } from '../../task-machine/immutability-guard.service.js';

export class ImmutabilityValidator {
  readonly layer = 6;
  private readonly guard = new ImmutabilityGuardService();

  validate(intention: ESAAIntention, roadmap: MaterializedRoadmap): void {
    const task = roadmap.tasks[intention.task_id];
    if (!task) {
      return;
    }

    try {
      this.guard.guard(task, intention.action);
    } catch {
      throw new ValidationError(
        this.layer,
        'immutable_done_violation',
        `Task '${intention.task_id}' is in 'done' state and cannot be modified via '${intention.action}'`,
      );
    }
  }
}
