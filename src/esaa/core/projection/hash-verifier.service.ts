import type { ESAAEventData, MaterializedRoadmap } from '../../shared/types/esaa-event.types.js';
import { hashProjection } from '../../shared/infrastructure/crypto-utils.js';
import { ProjectorService } from './projector.service.js';

export interface VerificationResult {
  valid: boolean;
  replayHash: string;
  storedHash: string;
  eventCount: number;
}

export class HashVerifierService {
  private readonly projector: ProjectorService;

  constructor(projector?: ProjectorService) {
    this.projector = projector ?? new ProjectorService();
  }

  verify(events: ESAAEventData[], currentRoadmap: MaterializedRoadmap): VerificationResult {
    const replayed = this.projector.project(events);

    const { projection_hash_sha256: _, ...replayData } = replayed;
    const replayHash = hashProjection(replayData);

    return {
      valid: replayHash === currentRoadmap.projection_hash_sha256,
      replayHash,
      storedHash: currentRoadmap.projection_hash_sha256,
      eventCount: events.length,
    };
  }

  computeHash(roadmap: MaterializedRoadmap): string {
    const { projection_hash_sha256: _, ...dataToHash } = roadmap;
    return hashProjection(dataToHash);
  }
}
