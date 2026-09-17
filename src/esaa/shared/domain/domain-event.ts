import { randomUUID } from 'node:crypto';

export abstract class DomainEvent {
  public readonly eventId: string;
  public readonly occurredOn: Date;
  public readonly eventVersion: number;

  constructor(eventVersion: number = 1) {
    this.eventId = randomUUID();
    this.occurredOn = new Date();
    this.eventVersion = eventVersion;
  }

  abstract get eventName(): string;

  abstract toPrimitives(): Record<string, unknown>;
}
