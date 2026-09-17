import { ValueObject } from '../../../shared/domain/value-object.js';

interface EventSeqProps {
  value: number;
}

export class EventSeq extends ValueObject<EventSeqProps> {
  private constructor(props: EventSeqProps) {
    super(props);
  }

  static create(seq: number): EventSeq {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`EventSeq must be a non-negative integer, got ${seq}`);
    }
    return new EventSeq({ value: seq });
  }

  static zero(): EventSeq {
    return new EventSeq({ value: 0 });
  }

  next(): EventSeq {
    return EventSeq.create(this.props.value + 1);
  }

  isAfter(other: EventSeq): boolean {
    return this.props.value > other.props.value;
  }

  toNumber(): number {
    return this.props.value;
  }
}
