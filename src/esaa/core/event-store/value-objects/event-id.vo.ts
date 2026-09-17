import { randomUUID } from 'node:crypto';
import { ValueObject } from '../../../shared/domain/value-object.js';

interface EventIdProps {
  value: string;
}

export class EventId extends ValueObject<EventIdProps> {
  private constructor(props: EventIdProps) {
    super(props);
  }

  static create(): EventId {
    return new EventId({ value: randomUUID() });
  }

  static fromString(id: string): EventId {
    if (!id || id.trim().length === 0) {
      throw new Error('EventId cannot be empty');
    }
    return new EventId({ value: id });
  }

  toString(): string {
    return this.props.value;
  }
}
