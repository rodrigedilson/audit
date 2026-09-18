import type { ESAAEventData, MaterializedRoadmap } from '../../shared/types/esaa-event.types.js';
import { hashProjection } from '../../shared/infrastructure/crypto-utils.js';
import { ProjectorService } from './projector.service.js';

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

export class HashVerifierService {
  private readonly projector: ProjectorService;

  constructor(projector?: ProjectorService) {
    this.projector = projector ?? new ProjectorService();
  }

  /**
   * Verifica a projeção em duas frentes, e ambas precisam fechar:
   *
   * 1. `contentHash === storedHash` — a projeção recebida é coerente com o próprio
   *    hash que carrega. Pega adulteração da view materializada.
   * 2. `replayHash === storedHash` — reprojetar o event log reproduz aquele hash.
   *    Pega adulteração ou perda de eventos.
   *
   * A checagem (1) faltava: a verificação antiga só comparava o replay contra a
   * string de hash guardada e nunca hasheava o conteúdo recebido, então uma
   * projeção com números alterados e hash intacto passava como válida. Com a
   * canonicalização do ADR-005 corrigida, (1) passa a ter valor real.
   */
  verify(events: ESAAEventData[], currentRoadmap: MaterializedRoadmap): VerificationResult {
    const replayHash = this.computeHash(this.projector.project(events));
    const contentHash = this.computeHash(currentRoadmap);
    const storedHash = currentRoadmap.projection_hash_sha256;

    return {
      valid: replayHash === storedHash && contentHash === storedHash,
      replayHash,
      contentHash,
      storedHash,
      eventCount: events.length,
    };
  }

  computeHash(roadmap: MaterializedRoadmap): string {
    const { projection_hash_sha256: _ignored, ...dataToHash } = roadmap;
    return hashProjection(dataToHash);
  }
}
