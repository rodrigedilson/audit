import type { ESAAIntention, ESAAEventData } from '../../shared/types/esaa-event.types.js';
import type { FiscalProjection } from '../../../fiscal/shared/fiscal-projection.types.js';
import type { ValidationError } from '../../shared/types/esaa-errors.js';
import { JsonParseValidator } from './validators/json-parse.validator.js';
import { SchemaValidator } from './validators/schema.validator.js';
import { VocabularyValidator } from './validators/vocabulary.validator.js';
import { StateMachineValidator } from './validators/state-machine.validator.js';
import { BoundaryValidator } from './validators/boundary.validator.js';
import { ImmutabilityValidator } from './validators/immutability.validator.js';
import { VerificationGateValidator } from './validators/verification-gate.validator.js';
import type { ContractEnforcerService } from '../contracts/contract-enforcer.service.js';
import type { FiscalHashVerifierService } from '../../../fiscal/projection/fiscal-hash-verifier.service.js';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  layerReached: number;
}

export class ValidationPipelineService {
  private readonly jsonParseValidator: JsonParseValidator;
  private readonly schemaValidator: SchemaValidator;
  private readonly vocabularyValidator: VocabularyValidator;
  private readonly stateMachineValidator: StateMachineValidator;
  private readonly boundaryValidator: BoundaryValidator;
  private readonly immutabilityValidator: ImmutabilityValidator;
  private readonly verificationGateValidator: VerificationGateValidator;

  constructor(
    contractEnforcer: ContractEnforcerService,
    hashVerifier: FiscalHashVerifierService,
  ) {
    this.jsonParseValidator = new JsonParseValidator();
    this.schemaValidator = new SchemaValidator();
    this.vocabularyValidator = new VocabularyValidator();
    this.stateMachineValidator = new StateMachineValidator();
    this.boundaryValidator = new BoundaryValidator(contractEnforcer);
    this.immutabilityValidator = new ImmutabilityValidator();
    this.verificationGateValidator = new VerificationGateValidator(hashVerifier);
  }

  validate(
    intention: ESAAIntention,
    projection: FiscalProjection,
    events: ESAAEventData[],
  ): ValidationResult {
    const errors: ValidationError[] = [];

    try {
      // Layer 1: JSON Parse
      this.jsonParseValidator.validate(intention);

      // Layer 2: Schema
      this.schemaValidator.validate(intention);

      // Layer 3: Vocabulary
      this.vocabularyValidator.validate(intention);

      // Layer 4: State Machine
      this.stateMachineValidator.validate(intention, projection);

      // Layer 5: Boundary
      this.boundaryValidator.validate(intention);

      // Layer 6: Immutability
      this.immutabilityValidator.validate(intention, projection);

      // Layer 7: Verification Gate
      this.verificationGateValidator.validate(events, projection);

      return { valid: true, errors: [], layerReached: 7 };
    } catch (error) {
      if (isValidationError(error)) {
        errors.push(error);
        return { valid: false, errors, layerReached: error.layer };
      }
      throw error;
    }
  }
}

function isValidationError(error: unknown): error is ValidationError {
  return error !== null && typeof error === 'object' && 'layer' in error && 'reason' in error;
}
