import type { DomainEvent } from './domain-event.js';

export abstract class Entity<T> {
  protected readonly _id: T;
  private _domainEvents: DomainEvent[] = [];

  constructor(id: T) {
    this._id = id;
  }

  get id(): T {
    return this._id;
  }

  public equals(object?: Entity<T>): boolean {
    if (object == null) {
      return false;
    }
    if (this === object) {
      return true;
    }
    if (!(object instanceof Entity)) {
      return false;
    }
    return this._id === object._id;
  }

  protected addDomainEvent(domainEvent: DomainEvent): void {
    this._domainEvents.push(domainEvent);
  }

  public getUncommittedEvents(): DomainEvent[] {
    return [...this._domainEvents];
  }

  public markEventsAsCommitted(): void {
    this._domainEvents = [];
  }
}
