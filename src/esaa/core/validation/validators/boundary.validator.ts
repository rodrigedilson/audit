import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import type { ContractEnforcerService } from '../../contracts/contract-enforcer.service.js';

export class BoundaryValidator {
  readonly layer = 5;

  constructor(private readonly enforcer: ContractEnforcerService) {}

  validate(intention: ESAAIntention): void {
    const result = this.enforcer.enforce(intention);

    if (!result.allowed) {
      throw new ValidationError(
        this.layer,
        'boundary_violation',
        result.violations.join('; '),
      );
    }
  }
}
