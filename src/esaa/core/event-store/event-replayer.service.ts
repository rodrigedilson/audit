import type { ESAAEventData } from '../../shared/types/esaa-event.types.js';
import type { IEventStoreRepository } from './event-store.repository.js';
import { EventStoreCorruptedError } from '../../shared/types/esaa-errors.js';

export class EventReplayerService {
  constructor(private readonly eventStore: IEventStoreRepository) {}

  async replayAll(): Promise<ESAAEventData[]> {
    const events = await this.eventStore.getAll();
    this.validateSequenceIntegrity(events);
    return events;
  }

  async replayFrom(fromSeq: number): Promise<ESAAEventData[]> {
    const events = await this.eventStore.getAfterSeq(fromSeq);
    return events;
  }

  async replayForTask(taskId: string): Promise<ESAAEventData[]> {
    return this.eventStore.getByTaskId(taskId);
  }

  private validateSequenceIntegrity(events: ESAAEventData[]): void {
    for (let i = 0; i < events.length; i++) {
      if (events[i].event_seq !== i) {
        throw new EventStoreCorruptedError(
          events[i].event_seq,
          `Expected seq ${i}, got ${events[i].event_seq}. Sequence is not monotonic.`,
        );
      }
    }
  }
}
