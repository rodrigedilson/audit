import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import { ValidationError, ClosedPeriodViolationError } from '../../../shared/types/esaa-errors.js';
import type { FiscalProjection } from '../../../../fiscal/shared/fiscal-projection.types.js';
import { ClosedPeriodGuardService } from '../../../../fiscal/period/period-transition.service.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';

/**
 * Camada 6 — imutabilidade da competência confirmada (INV-001).
 *
 * É a camada que impede o caso mais caro do produto: alterar em silêncio um
 * número já entregue ao Fisco. A correção existe, mas por retificação, que abre
 * competência nova e preserva o hash original.
 */
export class ImmutabilityValidator {
  private readonly guard = new ClosedPeriodGuardService();

  validate(intention: ESAAIntention, projection: FiscalProjection): void {
    try {
      this.guard.guard(projection, intention.action, intention.period);
    } catch (cause) {
      if (cause instanceof ClosedPeriodViolationError) {
        throw new ValidationError(6, 'closed_period_violation', cause.message, CRITERIOS_INTERNOS['competencia-confirmada-e-terminal']);
      }
      throw cause;
    }
  }
}
