import { ValueObject } from '../../../shared/domain/value-object.js';
import { TASK_STATES, VALID_TRANSITIONS, type TaskState } from '../../../shared/types/esaa-vocabulary.js';
import { InvalidTransitionError } from '../../../shared/types/esaa-errors.js';

interface TaskStateProps {
  value: TaskState;
}

export class TaskStateVO extends ValueObject<TaskStateProps> {
  private constructor(props: TaskStateProps) {
    super(props);
  }

  static create(state: TaskState): TaskStateVO {
    if (!(TASK_STATES as readonly string[]).includes(state)) {
      throw new Error(`Invalid task state: ${state}`);
    }
    return new TaskStateVO({ value: state });
  }

  static todo(): TaskStateVO {
    return new TaskStateVO({ value: 'todo' });
  }

  canTransitionTo(target: TaskState): boolean {
    return VALID_TRANSITIONS[this.props.value].includes(target);
  }

  transitionTo(target: TaskState, taskId: string): TaskStateVO {
    if (!this.canTransitionTo(target)) {
      throw new InvalidTransitionError(taskId, this.props.value, target);
    }
    return TaskStateVO.create(target);
  }

  isDone(): boolean {
    return this.props.value === 'done';
  }

  isTodo(): boolean {
    return this.props.value === 'todo';
  }

  isInProgress(): boolean {
    return this.props.value === 'in_progress';
  }

  isInReview(): boolean {
    return this.props.value === 'review';
  }

  toString(): string {
    return this.props.value;
  }
}
