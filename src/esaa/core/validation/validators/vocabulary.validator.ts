import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import { isValidAction, isAgentAction, isOrchestratorAction, AGENT_TO_TASK_KIND } from '../../../shared/types/esaa-vocabulary.js';

export class VocabularyValidator {
  readonly layer = 3;

  validate(intention: ESAAIntention): void {
    if (!isValidAction(intention.action)) {
      throw new ValidationError(
        this.layer,
        'unknown_action',
        `Unknown action '${intention.action}'`,
      );
    }

    const isKnownAgent = intention.actor in AGENT_TO_TASK_KIND;
    if (!isKnownAgent) {
      throw new ValidationError(
        this.layer,
        'unknown_action',
        `Unknown actor '${intention.actor}'`,
      );
    }

    const isOrchestrator = intention.actor === 'tech-lead';
    if (isOrchestrator && isAgentAction(intention.action)) {
      // Orchestrator can also emit agent actions in certain contexts (e.g., review)
    } else if (!isOrchestrator && isOrchestratorAction(intention.action)) {
      throw new ValidationError(
        this.layer,
        'unknown_action',
        `Agent '${intention.actor}' cannot emit orchestrator action '${intention.action}'`,
      );
    }
  }
}
