import { EventScope } from '../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import type { ESAAEventData } from '../../src/esaa/shared/types/esaa-event.types.js';
import type { ESAAAction } from '../../src/esaa/shared/types/esaa-vocabulary.js';

/**
 * Escopo padrão dos testes. Fixo de propósito: eventos com tenant/CNPJ estáveis
 * mantêm o hash da projeção reproduzível entre execuções, o que é pré-requisito
 * dos testes de determinismo (INV-006).
 */
export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const TEST_CNPJ = '12345678000195';
export const TEST_SCOPE = EventScope.create(TEST_TENANT_ID, TEST_CNPJ);

/** Um segundo escopo, para provar isolamento entre tenants. */
export const OTHER_TENANT_ID = '22222222-2222-2222-2222-222222222222';
export const OTHER_CNPJ = '98765432000110';
export const OTHER_SCOPE = EventScope.create(OTHER_TENANT_ID, OTHER_CNPJ);

export interface MakeEventOptions {
  scope?: EventScope;
  period?: string;
  ts?: string;
  eventId?: string;
}

/** Monta um `ESAAEventData` completo e já escopado. */
export function makeEvent(
  seq: number,
  action: string,
  taskId: string,
  actor: string,
  payload: Record<string, unknown>,
  options: MakeEventOptions = {},
): ESAAEventData {
  const scope = options.scope ?? TEST_SCOPE;

  const event: ESAAEventData = {
    event_id: options.eventId ?? `evt-${seq}`,
    event_seq: seq,
    action: action as ESAAAction,
    task_id: taskId,
    actor,
    ts: options.ts ?? `2027-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    schema_version: '0.4.0',
    tenant_id: scope.tenantId,
    cnpj: scope.cnpj,
    payload: payload as never,
  };

  if (options.period !== undefined) {
    event.period = options.period;
  }

  return event;
}
