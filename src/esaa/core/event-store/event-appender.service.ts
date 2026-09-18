import type { ESAAEventData } from '../../shared/types/esaa-event.types.js';
import type { IEventStoreRepository } from './event-store.repository.js';
import { EventEntry } from './event-entry.entity.js';
import type { EventScope } from './value-objects/event-scope.vo.js';
import type { ESAAAction } from '../../shared/types/esaa-vocabulary.js';
import { EventStoreCorruptedError } from '../../shared/types/esaa-errors.js';

export interface AppendInput {
  action: ESAAAction;
  taskId: string;
  actor: string;
  payload: Record<string, unknown>;
  period?: string;
}

/**
 * Serializa a escrita de um único par (tenant, CNPJ). A instância **é** o escopo:
 * o repositório recebido já está escopado, e o appender estampa tenant e CNPJ em
 * todo evento para que a linha carregue sua própria chave de partição e de RLS.
 */
export class EventAppenderService {
  constructor(
    private readonly eventStore: IEventStoreRepository,
    private readonly scope: EventScope,
  ) {}

  /**
   * A posição na sequência é atribuída pelo store, não aqui: só o adapter
   * consegue alocar e gravar atomicamente. O `seq: 0` abaixo é descartado — a
   * entidade existe para montar e validar o envelope, e `appendNext` sobrescreve
   * a posição.
   */
  async append(input: AppendInput): Promise<ESAAEventData> {
    const entry = EventEntry.create({
      scope: this.scope,
      seq: 0,
      action: input.action,
      taskId: input.taskId,
      actorName: input.actor,
      payload: input.payload as never,
      period: input.period,
    });

    const { event_seq: _discarded, ...draft } = entry.toData();

    return this.eventStore.appendNext(draft);
  }

  async appendRaw(event: ESAAEventData): Promise<void> {
    this.assertInScope(event);

    const lastSeq = await this.eventStore.getLastSeq();

    if (event.event_seq !== lastSeq + 1) {
      throw new EventStoreCorruptedError(
        event.event_seq,
        `Expected seq ${lastSeq + 1}, got ${event.event_seq}. Gap detected.`,
      );
    }

    await this.eventStore.append(event);
  }

  getScope(): EventScope {
    return this.scope;
  }

  /**
   * Um evento de outro tenant ou de outro CNPJ jamais deve entrar neste log: além
   * do vazamento, ele consumiria um `event_seq` da sequência errada e quebraria o
   * replay determinístico dos dois escopos envolvidos.
   */
  private assertInScope(event: ESAAEventData): void {
    if (event.tenant_id !== this.scope.tenantId || event.cnpj !== this.scope.cnpj) {
      throw new EventStoreCorruptedError(
        event.event_seq,
        `Evento fora do escopo: log é de '${this.scope.toKey()}', ` +
          `evento é de '${event.tenant_id}:${event.cnpj}'.`,
      );
    }
  }
}
