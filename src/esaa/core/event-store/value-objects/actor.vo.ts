import { ValueObject } from '../../../shared/domain/value-object.js';
import {
  AGENT_TO_TASK_KIND,
  ORCHESTRATOR_AGENT,
  isUserActor,
  type AgentTaskKind,
} from '../../../../fiscal/shared/fiscal-vocabulary.js';

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

  get taskKind(): AgentTaskKind | undefined {
    return AGENT_TO_TASK_KIND[this.props.name];
  }

  /**
   * Usuário age através da API, que **é** o orquestrador; agente só propõe. O
   * nome do agente orquestrador vem do vocabulário, e não hardcoded como antes
   * (`=== 'tech-lead'`), que amarrava o kernel a um agente do domínio antigo.
   */
  isOrchestrator(): boolean {
    return this.props.name === ORCHESTRATOR_AGENT || isUserActor(this.props.name);
  }

  isUser(): boolean {
    return isUserActor(this.props.name);
  }

  toString(): string {
    return this.props.name;
  }
}
