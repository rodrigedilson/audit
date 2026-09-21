import type { ESAAEventData } from '../../esaa/shared/types/esaa-event.types.js';
import { hashProjection } from '../../esaa/shared/infrastructure/crypto-utils.js';
import type { FiscalProjection } from '../shared/fiscal-projection.types.js';
import { FiscalProjectorService } from './fiscal-projector.service.js';

export interface VerificationResult {
  valid: boolean;
  /** Hash do replay determinístico do event log (INV-006). */
  replayHash: string;
  /** Hash recalculado sobre o conteúdo da projeção recebida. */
  contentHash: string;
  /** Hash gravado no campo `projection_hash_sha256` da projeção recebida. */
  storedHash: string;
  eventCount: number;
}

export class FiscalHashVerifierService {
  private readonly projector: FiscalProjectorService;

  constructor(projector?: FiscalProjectorService) {
    this.projector = projector ?? new FiscalProjectorService();
  }

  /**
   * Verifica em duas frentes, e ambas precisam fechar:
   *
   * 1. `contentHash === storedHash` — a projeção é coerente com o hash que
   *    carrega. Pega adulteração da view materializada.
   * 2. `replayHash === storedHash` — reprojetar o log reproduz aquele hash.
   *    Pega evento alterado, perdido ou acrescentado.
   *
   * A checagem (1) faltava na versão original: só o replay era comparado com a
   * string guardada, então uma projeção com números alterados e hash intacto
   * passava como válida.
   */
  verify(events: readonly ESAAEventData[], current: FiscalProjection): VerificationResult {
    const replayHash = this.computeHash(
      this.projector.project(current.tenant_id, current.cnpj, events),
    );
    const contentHash = this.computeHash(current);
    const storedHash = current.projection_hash_sha256;

    return {
      valid: replayHash === storedHash && contentHash === storedHash,
      replayHash,
      contentHash,
      storedHash,
      eventCount: events.length,
    };
  }

  computeHash(projection: FiscalProjection): string {
    const { projection_hash_sha256: _ignored, ...dataToHash } = projection;
    return hashProjection(dataToHash);
  }
}
