import { ValidationError } from '../../../shared/types/esaa-errors.js';
import type { ESAAEventData, MaterializedRoadmap } from '../../../shared/types/esaa-event.types.js';
import { HashVerifierService } from '../../projection/hash-verifier.service.js';

export class VerificationGateValidator {
  readonly layer = 7;

  constructor(private readonly hashVerifier: HashVerifierService) {}

  validate(events: ESAAEventData[], roadmap: MaterializedRoadmap): void {
    if (events.length === 0) {
      return;
    }

    const result = this.hashVerifier.verify(events, roadmap);

    if (!result.valid) {
      throw new ValidationError(
        this.layer,
        'verification_mismatch',
        `Projection hash mismatch: stored=${result.storedHash.substring(0, 16)}..., replay=${result.replayHash.substring(0, 16)}...`,
      );
    }
  }
}
