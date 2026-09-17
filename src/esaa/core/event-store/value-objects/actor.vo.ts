import { ValueObject } from '../../../shared/domain/value-object.js';
import { AGENT_TO_TASK_KIND, type TaskKind } from '../../../shared/types/esaa-vocabulary.js';

interface ActorProps {
  name: string;
}

export class Actor extends ValueObject<ActorProps> {
  private constructor(props: ActorProps) {
    super(props);
  }

  static create(name: string): Actor {
    if (!name || name.trim().length === 0) {
      throw new Error('Actor name cannot be empty');
    }
    return new Actor({ name: name.trim().toLowerCase() });
  }

  get name(): string {
    return this.props.name;
  }

  get taskKind(): TaskKind | undefined {
    return AGENT_TO_TASK_KIND[this.props.name];
  }

  isOrchestrator(): boolean {
    return this.props.name === 'tech-lead';
  }

  toString(): string {
    return this.props.name;
  }
}
