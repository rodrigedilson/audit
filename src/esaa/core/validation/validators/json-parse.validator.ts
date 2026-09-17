import { ValidationError } from '../../../shared/types/esaa-errors.js';

export class JsonParseValidator {
  readonly layer = 1;

  validate(raw: unknown): void {
    if (raw === null || raw === undefined) {
      throw new ValidationError(this.layer, 'schema_violation', 'Input is null or undefined');
    }

    if (typeof raw !== 'object') {
      throw new ValidationError(this.layer, 'schema_violation', `Expected object, got ${typeof raw}`);
    }

    const obj = raw as Record<string, unknown>;
    const required = ['action', 'task_id', 'actor', 'payload'];
    const missing = required.filter((key) => !(key in obj));

    if (missing.length > 0) {
      throw new ValidationError(
        this.layer,
        'schema_violation',
        `Missing required fields: ${missing.join(', ')}`,
      );
    }
  }
}
