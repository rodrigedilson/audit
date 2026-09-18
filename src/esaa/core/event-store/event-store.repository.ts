import type { ESAAEventData } from '../../shared/types/esaa-event.types.js';

/**
 * Um evento pronto para gravar, exceto a posição na sequência — que só o store
 * pode atribuir, porque só ele consegue fazê-lo atomicamente.
 */
export type EventDraft = Omit<ESAAEventData, 'event_seq'>;

/**
 * Porta única de persistência do event log. A instância **é** o escopo: está
 * amarrada a um par (tenant, CNPJ), e por isso os métodos não recebem escopo.
 * Ver ADR-003.
 */
export interface IEventStoreRepository {
  /**
   * Aloca o próximo `event_seq` e grava, de forma atômica.
   *
   * Existe porque a alocação era um read-modify-write em JavaScript
   * (`getLastSeq()` + 1 + `append()`), com uma janela de corrida entre a leitura
   * e a escrita. Atomicidade é propriedade do adapter — no Postgres, um advisory
   * lock por CNPJ dentro da transação (INV-004 e INV-005) — e não há como o
   * appender garanti-la de fora.
   */
  appendNext(draft: EventDraft): Promise<ESAAEventData>;

  /** Grava com `event_seq` já definido. Usado por importação e replay. */
  append(event: ESAAEventData): Promise<void>;

  getAll(): Promise<ESAAEventData[]>;
  getAfterSeq(seq: number): Promise<ESAAEventData[]>;
  getLastSeq(): Promise<number>;
  getByTaskId(taskId: string): Promise<ESAAEventData[]>;
  count(): Promise<number>;
}
