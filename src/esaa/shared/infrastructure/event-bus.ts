import type { DomainEvent } from '../domain/domain-event.js';

type EventHandler = (event: DomainEvent) => void | Promise<void>;

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();

  subscribe(eventName: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventName) ?? [];
    for (const handler of handlers) {
      await handler(event);
    }
  }

  async publishAll(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
