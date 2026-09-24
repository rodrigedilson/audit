import { InvalidTransitionError, ClosedPeriodViolationError } from '../../esaa/shared/types/esaa-errors.js';
import {
  VALID_PERIOD_TRANSITIONS,
  isValidPeriodTransition,
  type FiscalAction,
  type PeriodState,
} from '../shared/fiscal-vocabulary.js';
import type { FiscalProjection } from '../shared/fiscal-projection.types.js';

/**
 * Ações que movem a competência, e para onde. O que não está aqui não altera o
 * estado do período.
 */
const ACTION_TO_STATE: Partial<Record<FiscalAction, PeriodState>> = {
  'assessment.projected': 'assessed',
  'assessment.adjusted': 'assessed',
  'assessment.compared': 'reconciled',
  'assessment.confirmed': 'confirmed',
};

/** Ações que exigem competência aberta, isto é, não confirmada. */
const MUTATING_ACTIONS: readonly FiscalAction[] = [
  'doc.received',
  'doc.manifested',
  'doc.cancelled',
  'sped.imported',
  'bank.statement.imported',
  'item.classified',
  'item.reclassified',
  'assessment.projected',
  'assessment.adjusted',
  'assessment.compared',
  'assessment.confirmed',
  'credit.recognized',
  'credit.conditioned',
  'credit.released',
  'period.closed',
];

export class PeriodTransitionService {
  /** Estado de destino de uma ação, ou o atual quando ela não move o período. */
  resolve(action: FiscalAction, current: PeriodState, periodId: string): PeriodState {
    const target = ACTION_TO_STATE[action];
    if (target === undefined) {
      return current;
    }

    if (!isValidPeriodTransition(current, target)) {
      throw new InvalidTransitionError(`competência ${periodId}`, current, target);
    }

    return target;
  }

  canTransition(from: PeriodState, to: PeriodState): boolean {
    return isValidPeriodTransition(from, to);
  }

  transitionsFrom(state: PeriodState): readonly PeriodState[] {
    return VALID_PERIOD_TRANSITIONS[state];
  }
}

/**
 * INV-001 no domínio fiscal: competência confirmada é imutável.
 *
 * A correção existe, mas por outro caminho: `rectification.filed` abre uma
 * competência de retificação vinculada e preserva o hash original. É o que
 * permite ao escritório mostrar o que entregou na época **e** o que corrigiu
 * depois, sem reescrever a história.
 */
export class ClosedPeriodGuardService {
  guard(projection: FiscalProjection, action: FiscalAction, periodId: string | undefined): void {
    if (periodId === undefined || !MUTATING_ACTIONS.includes(action)) {
      return;
    }

    const period = projection.periods[periodId];
    if (period?.state === 'confirmed') {
      throw new ClosedPeriodViolationError(periodId, projection.cnpj);
    }
  }

  isConfirmed(projection: FiscalProjection, periodId: string): boolean {
    return projection.periods[periodId]?.state === 'confirmed';
  }
}
