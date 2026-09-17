import type { ESAAEventData } from '../../shared/types/esaa-event.types.js';
import type { IEventStoreRepository } from './event-store.repository.js';
import { EventEntry } from './event-entry.entity.js';
import type { ESAAAction } from '../../shared/types/esaa-vocabulary.js';
import { EventStoreCorruptedError } from '../../shared/types/esaa-errors.js';

export class EventAppenderService {
  constructor(private readonly eventStore: IEventStoreRepository) {}

  async append(
    action: ESAAAction,
    taskId: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<ESAAEventData> {
    const lastSeq = await this.eventStore.getLastSeq();
    const nextSeq = lastSeq + 1;

    const entry = EventEntry.create(nextSeq, action, taskId, actor, payload as never);
    const data = entry.toData();

    await this.eventStore.append(data);

    return data;
  }

  async appendRaw(event: ESAAEventData): Promise<void> {
    const lastSeq = await this.eventStore.getLastSeq();

    if (event.event_seq !== lastSeq + 1) {
      throw new EventStoreCorruptedError(
        event.event_seq,
        `Expected seq ${lastSeq + 1}, got ${event.event_seq}. Gap detected.`,
      );
    }

    await this.eventStore.append(event);
  }
}
