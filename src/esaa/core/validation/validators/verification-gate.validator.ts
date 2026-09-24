import type { ESAAEventData } from '../../../shared/types/esaa-event.types.js';
import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { FiscalProjection } from '../../../../fiscal/shared/fiscal-projection.types.js';
import type { FiscalHashVerifierService } from '../../../../fiscal/projection/fiscal-hash-verifier.service.js';
import { CRITERIOS_INTERNOS } from '../../../../fiscal/shared/criterios-internos.js';

/**
 * Camada 7 — portão de verificação.
 *
 * Confere que a projeção sobre a qual a intenção está sendo avaliada ainda fecha
 * com o event log. Se não fecha, a decisão seria tomada sobre um estado que não
 * deriva dos documentos, e é justamente isso que o hash existe para impedir.
 *
 * Na Onda 6 esta camada passa a consultar também a Calculadora RFB como oráculo,
 * produzindo `fisco_mismatch`.
 */
export class VerificationGateValidator {
  constructor(private readonly hashVerifier: FiscalHashVerifierService) {}

  validate(events: readonly ESAAEventData[], projection: FiscalProjection): void {
    // Log vazio: não há o que verificar, e exigir hash de nada rejeitaria o
    // primeiro evento de todo CNPJ novo.
    if (events.length === 0) {
      return;
    }

    const result = this.hashVerifier.verify(events, projection);
    if (!result.valid) {
      throw new ValidationError(
        7,
        'verification_mismatch',
        `Projeção não fecha com o log: gravado ${result.storedHash}, ` +
          `replay ${result.replayHash}, conteúdo ${result.contentHash}.`,
      CRITERIOS_INTERNOS['projecao-fecha-com-o-log'],
    );
    }
  }
}
