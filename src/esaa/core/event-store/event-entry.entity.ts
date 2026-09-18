import { Entity } from '../../shared/domain/entity.js';
import type { ESAAEventData, ESAAPayload } from '../../shared/types/esaa-event.types.js';
import type { ESAAAction } from '../../shared/types/esaa-vocabulary.js';
import { EventId } from './value-objects/event-id.vo.js';
import { EventSeq } from './value-objects/event-seq.vo.js';
import { Actor } from './value-objects/actor.vo.js';
import { EventScope } from './value-objects/event-scope.vo.js';

const SCHEMA_VERSION = '0.4.0';

export interface NewEventInput {
  scope: EventScope;
  seq: number;
  action: ESAAAction;
  taskId: string;
  actorName: string;
  payload: ESAAPayload;
  period?: string;
}

export class EventEntry extends Entity<string> {
  private constructor(
    private readonly eventId: EventId,
    private readonly eventSeq: EventSeq,
    private readonly action: ESAAAction,
    private readonly taskId: string,
    private readonly actor: Actor,
    private readonly timestamp: Date,
    private readonly payload: ESAAPayload,
    private readonly scope: EventScope,
    private readonly period: string | undefined,
  ) {
    super(eventId.toString());
  }

  /**
   * Recebe um objeto em vez de posicionais porque o escopo elevou a contagem de
   * parâmetros a sete, e `create(seq, action, taskId, actor, tenant, cnpj, period)`
   * é um convite a trocar tenant por cnpj sem o compilador reclamar.
   */
  static create(input: NewEventInput): EventEntry {
    return new EventEntry(
      EventId.create(),
      EventSeq.create(input.seq),
      input.action,
      input.taskId,
      Actor.create(input.actorName),
      new Date(),
      input.payload,
      input.scope,
      input.period,
    );
  }

  static fromData(data: ESAAEventData): EventEntry {
    return new EventEntry(
      EventId.fromString(data.event_id),
      EventSeq.create(data.event_seq),
      data.action,
      data.task_id,
      Actor.create(data.actor),
      new Date(data.ts),
      data.payload,
      EventScope.create(data.tenant_id, data.cnpj),
      data.period,
    );
  }

  toData(): ESAAEventData {
    const data: ESAAEventData = {
      event_id: this.eventId.toString(),
      event_seq: this.eventSeq.toNumber(),
      action: this.action,
      task_id: this.taskId,
      actor: this.actor.toString(),
      ts: this.timestamp.toISOString(),
      schema_version: SCHEMA_VERSION,
      tenant_id: this.scope.tenantId,
      cnpj: this.scope.cnpj,
      payload: this.payload,
    };

    // Omitido quando ausente em vez de gravado como null: o schema do evento tem
    // `additionalProperties: false` e a canonicalizacao do hash ignora undefined,
    // então um `period: null` mudaria o hash sem mudar o significado.
    if (this.period !== undefined) {
      data.period = this.period;
    }

    return data;
  }

  getScope(): EventScope {
    return this.scope;
  }

  getPeriod(): string | undefined {
    return this.period;
  }

  toJSON(): string {
    return JSON.stringify(this.toData());
  }

  getAction(): ESAAAction {
    return this.action;
  }

  getTaskId(): string {
    return this.taskId;
  }

  getActor(): Actor {
    return this.actor;
  }

  getSeq(): number {
    return this.eventSeq.toNumber();
  }

  getPayload(): ESAAPayload {
    return this.payload;
  }

  getTimestamp(): Date {
    return this.timestamp;
  }
}
