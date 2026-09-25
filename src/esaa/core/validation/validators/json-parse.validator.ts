import { ValidationError } from '../../../shared/types/esaa-errors.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';

export class JsonParseValidator {
  readonly layer = 1;

  validate(raw: unknown): void {
    if (raw === null || raw === undefined) {
      throw new ValidationError(this.layer, 'schema_violation', 'Input is null or undefined', CRITERIOS_INTERNOS['contrato-intencao']);
    }

    if (typeof raw !== 'object') {
      throw new ValidationError(this.layer, 'schema_violation', `Expected object, got ${typeof raw}`, CRITERIOS_INTERNOS['contrato-intencao']);
    }

    const obj = raw as Record<string, unknown>;
    const required = ['action', 'task_id', 'actor', 'payload'];
    const missing = required.filter((key) => !(key in obj));

    if (missing.length > 0) {
      throw new ValidationError(
        this.layer,
        'schema_violation',
        `Missing required fields: ${missing.join(', ')}`,
      CRITERIOS_INTERNOS['contrato-intencao'],
    );
    }
  }
}
