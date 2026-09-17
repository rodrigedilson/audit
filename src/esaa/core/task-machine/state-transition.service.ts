import type { ESAAAction, TaskState } from '../../shared/types/esaa-vocabulary.js';
import { isValidTransition } from '../../shared/types/esaa-vocabulary.js';
import { InvalidTransitionError } from '../../shared/types/esaa-errors.js';

const ACTION_TO_TARGET_STATE: Partial<Record<ESAAAction, TaskState>> = {
  claim: 'in_progress',
  complete: 'review',
};

export class StateTransitionService {
  resolveTransition(
    action: ESAAAction,
    currentState: TaskState,
    taskId: string,
    reviewVerdict?: 'approve' | 'request_changes',
  ): TaskState {
    let targetState: TaskState;

    if (action === 'review') {
      targetState = reviewVerdict === 'approve' ? 'done' : 'in_progress';
    } else {
      const mapped = ACTION_TO_TARGET_STATE[action];
      if (!mapped) {
        return currentState;
      }
      targetState = mapped;
    }

    if (!isValidTransition(currentState, targetState)) {
      throw new InvalidTransitionError(taskId, currentState, targetState);
    }

    return targetState;
  }

  canTransition(currentState: TaskState, targetState: TaskState): boolean {
    return isValidTransition(currentState, targetState);
  }
}
