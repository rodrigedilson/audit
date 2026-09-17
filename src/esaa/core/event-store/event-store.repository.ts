import type { ESAAEventData } from '../../shared/types/esaa-event.types.js';

export interface IEventStoreRepository {
  append(event: ESAAEventData): Promise<void>;
  getAll(): Promise<ESAAEventData[]>;
  getAfterSeq(seq: number): Promise<ESAAEventData[]>;
  getLastSeq(): Promise<number>;
  getByTaskId(taskId: string): Promise<ESAAEventData[]>;
  count(): Promise<number>;
}
