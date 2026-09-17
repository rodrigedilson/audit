import type { MaterializedTask } from '../../shared/types/esaa-event.types.js';
import { ImmutabilityViolationError } from '../../shared/types/esaa-errors.js';
import type { ESAAAction } from '../../shared/types/esaa-vocabulary.js';

const MUTATION_ACTIONS: ESAAAction[] = ['claim', 'complete', 'review'];

export class ImmutabilityGuardService {
  guard(task: MaterializedTask, action: ESAAAction): void {
    if (task.state === 'done' && MUTATION_ACTIONS.includes(action)) {
      throw new ImmutabilityViolationError(task.task_id);
    }
  }

  isDone(task: MaterializedTask): boolean {
    return task.state === 'done';
  }
}
