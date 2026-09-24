import type { ESAAIntention } from '../../../shared/types/esaa-event.types.js';
import { ValidationError } from '../../../shared/types/esaa-errors.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';
import {
  isAgentAction,
  isKnownAgent,
  isOrchestratorAction,
  isUserActor,
  isValidAction,
  ORCHESTRATOR_AGENT,
} from '../../../../fiscal/shared/fiscal-vocabulary.js';

/**
 * Camada 3 — vocabulário controlado.
 *
 * Duas regras, e a segunda é o argumento de governança que se vende ao
 * escritório: **nenhuma IA altera um número fiscal sozinha**. Agente só emite
 * ação de proposta; efetivar é do orquestrador, e um usuário age através da API,
 * que é o orquestrador.
 */
export class VocabularyValidator {
  validate(intention: ESAAIntention): void {
    const { action, actor } = intention;

    if (!isValidAction(action)) {
      throw new ValidationError(3, 'unknown_action', `Ação '${action}' não existe no vocabulário.`, CRITERIOS_INTERNOS['vocabulario-fechado']);
    }

    const isUser = isUserActor(actor);
    if (!isUser && !isKnownAgent(actor)) {
      throw new ValidationError(
        3,
        'unknown_action',
        `Actor '${actor}' não é um usuário nem um agente registrado.`,
      CRITERIOS_INTERNOS['vocabulario-fechado'],
    );
    }

    if (isOrchestratorAction(action) && !isUser && actor !== ORCHESTRATOR_AGENT) {
      throw new ValidationError(
        3,
        'boundary_violation',
        `Agente '${actor}' não pode emitir '${action}': ações que efetivam estado ` +
          'são do orquestrador. O agente pode propor, e a proposta é revisada por humano.',
      CRITERIOS_INTERNOS['proposta-e-efetivacao'],
    );
    }

    if (isAgentAction(action) && isUser) {
      throw new ValidationError(
        3,
        'boundary_violation',
        `'${action}' é uma proposta de agente; um usuário registra o ato final, não a proposta.`,
      CRITERIOS_INTERNOS['proposta-e-efetivacao'],
    );
    }
  }
}
