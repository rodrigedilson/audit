import { ValueObject } from '../../../shared/domain/value-object.js';
import { TASK_KINDS, type TaskKind } from '../../../shared/types/esaa-vocabulary.js';

interface TaskKindProps {
  value: TaskKind;
}

export class TaskKindVO extends ValueObject<TaskKindProps> {
  private constructor(props: TaskKindProps) {
    super(props);
  }

  static create(kind: TaskKind): TaskKindVO {
    if (!(TASK_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Invalid task kind: ${kind}`);
    }
    return new TaskKindVO({ value: kind });
  }

  isSpec(): boolean {
    return this.props.value === 'spec';
  }

  isImpl(): boolean {
    return this.props.value === 'impl';
  }

  isQA(): boolean {
    return this.props.value === 'qa';
  }

  isReview(): boolean {
    return this.props.value === 'review';
  }

  isHotfix(): boolean {
    return this.props.value === 'hotfix';
  }

  toString(): string {
    return this.props.value;
  }
}
