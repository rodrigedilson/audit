import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import { ValidationError } from '../../../shared/types/esaa-errors.js';
import { InvalidTransitionError } from '../../../shared/types/esaa-errors.js';
import type { FiscalProjection } from '../../../../fiscal/shared/fiscal-projection.types.js';
import { PeriodTransitionService } from '../../../../fiscal/period/period-transition.service.js';
import { isValidPeriodId } from '../../../../fiscal/shared/fiscal-vocabulary.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';

/**
 * Camada 4 — ciclo de vida da competência.
 *
 * `open → assessed → reconciled → confirmed`, com volta de `reconciled` para
 * `assessed` via ajuste. `confirmed` é terminal.
 */
export class StateMachineValidator {
  private readonly transitions = new PeriodTransitionService();

  validate(intention: ESAAIntention, projection: FiscalProjection): void {
    const periodId = intention.period;
    if (periodId === undefined) {
      return;
    }

    if (!isValidPeriodId(periodId)) {
      throw new ValidationError(
        4,
        'schema_violation',
        `Competência '${periodId}' fora do formato YYYY-MM.`,
      CRITERIOS_INTERNOS['contrato-intencao'],
    );
    }

    // `period.opened` cria a competência; as demais exigem que ela exista.
    if (intention.action === 'period.opened') {
      if (projection.periods[periodId]) {
        throw new ValidationError(
          4,
          'invalid_transition',
          `Competência ${periodId} já está aberta.`,
        CRITERIOS_INTERNOS['ciclo-da-competencia'],
      );
      }
      return;
    }

    const period = projection.periods[periodId];
    if (!period) {
      throw new ValidationError(
        4,
        'invalid_transition',
        `Competência ${periodId} não foi aberta para este CNPJ.`,
      CRITERIOS_INTERNOS['ciclo-da-competencia'],
    );
    }

    try {
      this.transitions.resolve(intention.action, period.state, periodId);
    } catch (cause) {
      if (cause instanceof InvalidTransitionError) {
        throw new ValidationError(4, 'invalid_transition', cause.message, CRITERIOS_INTERNOS['ciclo-da-competencia']);
      }
      throw cause;
    }
  }
}
