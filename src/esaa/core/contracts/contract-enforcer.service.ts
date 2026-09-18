import type { ESAAIntention } from '../../shared/types/esaa-event.types.js';
import { isUserActor } from '../../../fiscal/shared/fiscal-vocabulary.js';
import type { ContractLoaderService } from './contract-loader.service.js';

export interface EnforcementResult {
  allowed: boolean;
  violations: string[];
}

/**
 * Aplica o `AGENT_CONTRACT.yaml`: que ações cada agente pode emitir e em que
 * diretórios pode escrever.
 *
 * **Só vale para agentes.** Um usuário age através da API, que é o orquestrador,
 * e não tem fronteira de arquivo — não escreve em diretório nenhum, escreve no
 * log. O que ele pode emitir é decidido pela camada 3 (vocabulário) e pelo papel
 * na associação (`owner`/`accountant`/`viewer`), verificado na fronteira HTTP.
 *
 * Antes desta distinção, uma intenção de usuário chegava aqui e estourava
 * `ContractNotFoundError`, porque o UUID dele não está no contrato de agentes.
 */
export class ContractEnforcerService {
  constructor(private readonly contractLoader: ContractLoaderService) {}

  enforce(intention: ESAAIntention): EnforcementResult {
    if (isUserActor(intention.actor)) {
      return { allowed: true, violations: [] };
    }

    const violations: string[] = [];

    const allowedActions = this.contractLoader.getAllowedActions(intention.actor);
    if (!allowedActions.includes(intention.action)) {
      violations.push(
        `Agente '${intention.actor}' não pode executar '${intention.action}'. ` +
          `Permitidas: ${allowedActions.join(', ')}`,
      );
    }

    if (intention.file_updates && intention.file_updates.length > 0) {
      const boundary = this.contractLoader.getBoundaryForAgent(intention.actor);
      for (const update of intention.file_updates) {
        if (!boundary.canWrite(update.path)) {
          violations.push(`Agente '${intention.actor}' não pode escrever em '${update.path}'`);
        }
      }
    }

    return { allowed: violations.length === 0, violations };
  }
}
