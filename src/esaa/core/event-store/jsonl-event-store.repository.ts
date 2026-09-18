import { readFile, appendFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ESAAEventData } from '../../shared/types/esaa-event.types.js';
import type { EventDraft, IEventStoreRepository } from './event-store.repository.js';

/**
 * Adapter de desenvolvimento e teste. Cada leitura relê e reparseia o arquivo
 * inteiro, e `appendNext` não é atômico — duas instâncias apontando para o mesmo
 * arquivo corromperiam a sequência. Produção usa
 * `PostgresEventStoreRepository`, que serializa a escrita por CNPJ.
 */
export class JsonlEventStoreRepository implements IEventStoreRepository {
  constructor(private readonly filePath: string) {}

  /**
   * Sem atomicidade: entre `getLastSeq()` e `appendFile` existe uma janela de
   * corrida. Aceitável aqui porque o uso é um processo único (CLI e testes), e é
   * exatamente a limitação que motiva o adapter Postgres.
   */
  async appendNext(draft: EventDraft): Promise<ESAAEventData> {
    const lastSeq = await this.getLastSeq();
    const event: ESAAEventData = { ...draft, event_seq: lastSeq + 1 };
    await this.append(event);
    return event;
  }

  async append(event: ESAAEventData): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    await appendFile(this.filePath, line, 'utf8');
  }

  async getAll(): Promise<ESAAEventData[]> {
    const content = await this.readFileContent();
    if (!content.trim()) return [];

    return content
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ESAAEventData);
  }

  async getAfterSeq(seq: number): Promise<ESAAEventData[]> {
    const all = await this.getAll();
    return all.filter((e) => e.event_seq > seq);
  }

  async getLastSeq(): Promise<number> {
    const all = await this.getAll();
    if (all.length === 0) return -1;
    return all[all.length - 1].event_seq;
  }

  async getByTaskId(taskId: string): Promise<ESAAEventData[]> {
    const all = await this.getAll();
    return all.filter((e) => e.task_id === taskId);
  }

  async count(): Promise<number> {
    const all = await this.getAll();
    return all.length;
  }

  async initialize(): Promise<void> {
    const exists = await this.fileExists();
    if (!exists) {
      await writeFile(this.filePath, '', 'utf8');
    }
  }

  private async readFileContent(): Promise<string> {
    const exists = await this.fileExists();
    if (!exists) return '';
    return readFile(this.filePath, 'utf8');
  }

  private async fileExists(): Promise<boolean> {
    try {
      await access(this.filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
