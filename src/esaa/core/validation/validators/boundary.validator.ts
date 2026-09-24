import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import type { ContractEnforcerService } from '../../contracts/contract-enforcer.service.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';

/**
 * Camada 5 — fronteiras do `AGENT_CONTRACT.yaml`. Aplica-se a agentes; usuários
 * passam direto (ver ContractEnforcerService).
 */
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
      CRITERIOS_INTERNOS['fronteira-do-agente'],
    );
    }
  }
}
