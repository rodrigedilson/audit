import type { IEventStoreRepository } from '../../core/event-store/event-store.repository.js';
import { ProjectorService } from '../../core/projection/projector.service.js';
import { Logger } from '../../shared/infrastructure/logger.js';

export interface IHiveMindMemory {
  store(key: string, namespace: string, value: unknown): Promise<void>;
  retrieve(key: string, namespace: string): Promise<unknown>;
}

export class MemoryEventSyncService {
  private readonly projector: ProjectorService;
  private readonly logger: Logger;
  private lastSyncSeq: number = -1;

  constructor(
    private readonly eventStore: IEventStoreRepository,
    private readonly hiveMindMemory: IHiveMindMemory,
  ) {
    this.projector = new ProjectorService();
    this.logger = new Logger('MemoryEventSync');
  }

  async sync(): Promise<{ synced: number }> {
    const newEvents = await this.eventStore.getAfterSeq(this.lastSyncSeq);

    if (newEvents.length === 0) {
      return { synced: 0 };
    }

    for (const event of newEvents) {
      await this.hiveMindMemory.store(
        `swarm/${event.actor}/esaa-status`,
        'coordination',
        {
          last_action: event.action,
          task_id: event.task_id,
          timestamp: event.ts,
          event_seq: event.event_seq,
        },
      );
    }

    const allEvents = await this.eventStore.getAll();
    const roadmap = this.projector.project(allEvents);

    await this.hiveMindMemory.store(
      'swarm/esaa/roadmap-snapshot',
      'software-engineering',
      {
        stats: roadmap.stats,
        run: roadmap.run,
        last_event_seq: roadmap.last_event_seq,
        projection_hash: roadmap.projection_hash_sha256,
      },
    );

    this.lastSyncSeq = newEvents[newEvents.length - 1].event_seq;

    await this.hiveMindMemory.store(
      'swarm/esaa/last-sync-seq',
      'coordination',
      this.lastSyncSeq,
    );

    this.logger.info('Memory sync completed', {
      synced: newEvents.length,
      lastSeq: this.lastSyncSeq,
    });

    return { synced: newEvents.length };
  }

  async restoreSyncState(): Promise<void> {
    const stored = await this.hiveMindMemory.retrieve(
      'swarm/esaa/last-sync-seq',
      'coordination',
    );
    if (typeof stored === 'number') {
      this.lastSyncSeq = stored;
    }
  }
}
