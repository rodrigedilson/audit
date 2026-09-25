import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';

export class SchemaValidator {
  readonly layer = 2;

  validate(intention: ESAAIntention): void {
    if (typeof intention.action !== 'string' || intention.action.trim().length === 0) {
      throw new ValidationError(this.layer, 'schema_violation', 'action must be a non-empty string', CRITERIOS_INTERNOS['contrato-intencao']);
    }

    if (typeof intention.task_id !== 'string' || intention.task_id.trim().length === 0) {
      throw new ValidationError(this.layer, 'schema_violation', 'task_id must be a non-empty string', CRITERIOS_INTERNOS['contrato-intencao']);
    }

    if (typeof intention.actor !== 'string' || intention.actor.trim().length === 0) {
      throw new ValidationError(this.layer, 'schema_violation', 'actor must be a non-empty string', CRITERIOS_INTERNOS['contrato-intencao']);
    }

    if (typeof intention.payload !== 'object' || intention.payload === null) {
      throw new ValidationError(this.layer, 'schema_violation', 'payload must be a non-null object', CRITERIOS_INTERNOS['contrato-intencao']);
    }

    if (intention.file_updates) {
      if (!Array.isArray(intention.file_updates)) {
        throw new ValidationError(this.layer, 'schema_violation', 'file_updates must be an array', CRITERIOS_INTERNOS['contrato-intencao']);
      }
      for (const update of intention.file_updates) {
        if (!update.path || typeof update.path !== 'string') {
          throw new ValidationError(this.layer, 'schema_violation', 'file_updates[].path must be a non-empty string', CRITERIOS_INTERNOS['contrato-intencao']);
        }
      }
    }
  }
}
