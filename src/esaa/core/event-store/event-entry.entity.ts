import { Entity } from '../../shared/domain/entity.js';
import type { ESAAEventData, ESAAPayload } from '../../shared/types/esaa-event.types.js';
import type { ESAAAction } from '../../shared/types/esaa-vocabulary.js';
import { EventId } from './value-objects/event-id.vo.js';
import { EventSeq } from './value-objects/event-seq.vo.js';
import { Actor } from './value-objects/actor.vo.js';

const SCHEMA_VERSION = '0.4.0';

export class EventEntry extends Entity<string> {
  private constructor(
    private readonly eventId: EventId,
    private readonly eventSeq: EventSeq,
    private readonly action: ESAAAction,
    private readonly taskId: string,
    private readonly actor: Actor,
    private readonly timestamp: Date,
    private readonly payload: ESAAPayload,
  ) {
    super(eventId.toString());
  }

  static create(
    seq: number,
    action: ESAAAction,
    taskId: string,
    actorName: string,
    payload: ESAAPayload,
  ): EventEntry {
    return new EventEntry(
      EventId.create(),
      EventSeq.create(seq),
      action,
      taskId,
      Actor.create(actorName),
      new Date(),
      payload,
    );
  }

  static fromData(data: ESAAEventData): EventEntry {
    return new EventEntry(
      EventId.fromString(data.event_id),
      EventSeq.create(data.event_seq),
      data.action,
      data.task_id,
      Actor.create(data.actor),
      new Date(data.ts),
      data.payload,
    );
  }

  toData(): ESAAEventData {
    return {
      event_id: this.eventId.toString(),
      event_seq: this.eventSeq.toNumber(),
      action: this.action,
      task_id: this.taskId,
      actor: this.actor.toString(),
      ts: this.timestamp.toISOString(),
      schema_version: SCHEMA_VERSION,
      payload: this.payload,
    };
  }

  toJSON(): string {
    return JSON.stringify(this.toData());
  }

  getAction(): ESAAAction {
    return this.action;
  }

  getTaskId(): string {
    return this.taskId;
  }

  getActor(): Actor {
    return this.actor;
  }

  getSeq(): number {
    return this.eventSeq.toNumber();
  }

  getPayload(): ESAAPayload {
    return this.payload;
  }

  getTimestamp(): Date {
    return this.timestamp;
  }
}
