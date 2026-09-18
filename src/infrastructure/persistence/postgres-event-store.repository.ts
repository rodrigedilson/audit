import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { ESAAEventData } from '../../esaa/shared/types/esaa-event.types.js';
import type {
  EventDraft,
  IEventStoreRepository,
} from '../../esaa/core/event-store/event-store.repository.js';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { ESAAAction } from '../../esaa/shared/types/esaa-vocabulary.js';
import { EventStoreCorruptedError } from '../../esaa/shared/types/esaa-errors.js';

interface EventRow extends QueryResultRow {
  event_id: string;
  event_seq: string | number;
  action: string;
  task_id: string;
  actor: string;
  period: string | null;
  ts: Date;
  schema_version: string;
  payload: Record<string, unknown>;
}

const SELECT_COLUMNS = `
  event_id, event_seq, action, task_id, actor, period, ts, schema_version, payload
`;

/**
 * Event store em Postgres, escopado a um par (tenant, CNPJ). Ver ADR-003.
 *
 * Duas coisas que o adapter JSONL não conseguia dar e que aqui são do banco:
 *
 * - **Atomicidade da sequência** (INV-004/INV-005): `appendNext` chama a função
 *   `append_event`, que toma `pg_advisory_xact_lock` por CNPJ, calcula
 *   `max(event_seq)+1` e insere na mesma transação. O lock é por CNPJ e não
 *   global, para que dois CNPJs do mesmo escritório fechem em paralelo.
 * - **Append-only de verdade**: um trigger rejeita UPDATE e DELETE na tabela, e
 *   um índice único em `event_id` cumpre a metade de INV-004 que nunca era
 *   verificada.
 */
export class PostgresEventStoreRepository implements IEventStoreRepository {
  constructor(
    private readonly pool: Pool,
    private readonly scope: EventScope,
  ) {}

  async appendNext(draft: EventDraft): Promise<ESAAEventData> {
    this.assertInScope(draft);

    const { rows } = await this.pool.query<{ append_event: string }>(
      `select append_event($1::uuid, $2::char(14), $3::uuid, $4, $5, $6,
                           $7::char(7), $8::timestamptz, $9, $10::jsonb) as append_event`,
      [
        this.scope.tenantId,
        this.scope.cnpj,
        draft.event_id,
        draft.action,
        draft.task_id,
        draft.actor,
        draft.period ?? null,
        draft.ts,
        draft.schema_version,
        JSON.stringify(draft.payload),
      ],
    );

    const seq = rows[0]?.append_event;
    if (seq === undefined) {
      throw new EventStoreCorruptedError(-1, 'append_event não devolveu event_seq');
    }

    return { ...draft, event_seq: Number(seq) };
  }

  async append(event: ESAAEventData): Promise<void> {
    this.assertInScope(event);

    await this.pool.query(
      `insert into events (
         tenant_id, cnpj, event_seq, event_id, action, task_id, actor,
         period, ts, schema_version, payload
       ) values ($1::uuid, $2::char(14), $3, $4::uuid, $5, $6, $7,
                 $8::char(7), $9::timestamptz, $10, $11::jsonb)`,
      [
        this.scope.tenantId,
        this.scope.cnpj,
        event.event_seq,
        event.event_id,
        event.action,
        event.task_id,
        event.actor,
        event.period ?? null,
        event.ts,
        event.schema_version,
        JSON.stringify(event.payload),
      ],
    );
  }

  async getAll(): Promise<ESAAEventData[]> {
    const { rows } = await this.pool.query<EventRow>(
      `select ${SELECT_COLUMNS} from events
        where tenant_id = $1::uuid and cnpj = $2::char(14)
        order by event_seq asc`,
      [this.scope.tenantId, this.scope.cnpj],
    );
    return rows.map((row) => this.toEvent(row));
  }

  async getAfterSeq(seq: number): Promise<ESAAEventData[]> {
    const { rows } = await this.pool.query<EventRow>(
      `select ${SELECT_COLUMNS} from events
        where tenant_id = $1::uuid and cnpj = $2::char(14) and event_seq > $3
        order by event_seq asc`,
      [this.scope.tenantId, this.scope.cnpj, seq],
    );
    return rows.map((row) => this.toEvent(row));
  }

  /**
   * Ao contrário do adapter JSONL, não carrega o log para descobrir o último
   * seq. `-1` para log vazio é o contrato da porta.
   */
  async getLastSeq(): Promise<number> {
    const { rows } = await this.pool.query<{ last_seq: string | null }>(
      `select max(event_seq)::text as last_seq from events
        where tenant_id = $1::uuid and cnpj = $2::char(14)`,
      [this.scope.tenantId, this.scope.cnpj],
    );

    const lastSeq = rows[0]?.last_seq;
    return lastSeq === null || lastSeq === undefined ? -1 : Number(lastSeq);
  }

  async getByTaskId(taskId: string): Promise<ESAAEventData[]> {
    const { rows } = await this.pool.query<EventRow>(
      `select ${SELECT_COLUMNS} from events
        where tenant_id = $1::uuid and cnpj = $2::char(14) and task_id = $3
        order by event_seq asc`,
      [this.scope.tenantId, this.scope.cnpj, taskId],
    );
    return rows.map((row) => this.toEvent(row));
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `select count(*)::text as total from events
        where tenant_id = $1::uuid and cnpj = $2::char(14)`,
      [this.scope.tenantId, this.scope.cnpj],
    );
    return Number(rows[0]?.total ?? 0);
  }

  getScope(): EventScope {
    return this.scope;
  }

  private toEvent(row: EventRow): ESAAEventData {
    const event: ESAAEventData = {
      event_id: row.event_id,
      // bigint chega como string no driver; converter evita comparação de
      // '10' < '9' no replay.
      event_seq: Number(row.event_seq),
      action: row.action as ESAAAction,
      task_id: row.task_id,
      actor: row.actor,
      ts: row.ts.toISOString(),
      schema_version: row.schema_version,
      tenant_id: this.scope.tenantId,
      cnpj: this.scope.cnpj,
      payload: row.payload as never,
    };

    // `char(7)` volta com padding se o valor for mais curto; e null tem de virar
    // ausência, não `period: null`, senão o hash da projeção muda sem o
    // significado mudar.
    if (row.period !== null) {
      event.period = row.period.trim();
    }

    return event;
  }

  /**
   * Defesa em profundidade: o escopo já entra nos parâmetros da query, então um
   * evento de outro tenant seria silenciosamente reescrito para este log. Falhar
   * é melhor que reescrever.
   */
  private assertInScope(event: EventDraft): void {
    if (event.tenant_id !== this.scope.tenantId || event.cnpj !== this.scope.cnpj) {
      throw new EventStoreCorruptedError(
        -1,
        `Evento fora do escopo: log é de '${this.scope.toKey()}', ` +
          `evento é de '${event.tenant_id}:${event.cnpj}'.`,
      );
    }
  }
}

/** Reexportado para quem precise de uma transação explícita (ex.: fechar período). */
export type { PoolClient };
