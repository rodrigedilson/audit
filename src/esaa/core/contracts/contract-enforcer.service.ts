import type { ESAAIntention } from '../../shared/types/esaa-event.types.js';
import type { ContractLoaderService } from './contract-loader.service.js';

export interface EnforcementResult {
  allowed: boolean;
  violations: string[];
}

export class ContractEnforcerService {
  constructor(private readonly contractLoader: ContractLoaderService) {}

  enforce(intention: ESAAIntention): EnforcementResult {
    const violations: string[] = [];

    const allowedActions = this.contractLoader.getAllowedActions(intention.actor);
    if (!allowedActions.includes(intention.action)) {
      violations.push(
        `Agent '${intention.actor}' cannot perform action '${intention.action}'. Allowed: ${allowedActions.join(', ')}`,
      );
    }

    if (intention.file_updates && intention.file_updates.length > 0) {
      const boundary = this.contractLoader.getBoundaryForAgent(intention.actor);
      for (const update of intention.file_updates) {
        if (!boundary.canWrite(update.path)) {
          violations.push(
            `Agent '${intention.actor}' cannot write to '${update.path}'`,
          );
        }
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
    };
  }
}
