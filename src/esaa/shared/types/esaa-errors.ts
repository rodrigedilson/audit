import type { RejectionReason } from './esaa-vocabulary.js';

export class ESAAError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ESAAError';
  }
}

export class ValidationError extends ESAAError {
  constructor(
    public readonly layer: number,
    public readonly reason: RejectionReason,
    public readonly details: string,
  ) {
    super(`Validation failed at layer ${layer}: ${reason} - ${details}`, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class ImmutabilityViolationError extends ESAAError {
  constructor(
    public readonly taskId: string,
  ) {
    super(`Task ${taskId} is in 'done' state and cannot be modified`, 'IMMUTABILITY_VIOLATION');
    this.name = 'ImmutabilityViolationError';
  }
}

export class BoundaryViolationError extends ESAAError {
  constructor(
    public readonly actor: string,
    public readonly path: string,
    public readonly permission: 'read' | 'write' | 'forbidden',
  ) {
    super(`Agent '${actor}' cannot ${permission} path '${path}'`, 'BOUNDARY_VIOLATION');
    this.name = 'BoundaryViolationError';
  }
}

export class InvalidTransitionError extends ESAAError {
  constructor(
    public readonly taskId: string,
    public readonly fromState: string,
    public readonly toState: string,
  ) {
    super(`Invalid transition for task ${taskId}: ${fromState} → ${toState}`, 'INVALID_TRANSITION');
    this.name = 'InvalidTransitionError';
  }
}

export class IntegrityViolationError extends ESAAError {
  constructor(
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(`Integrity violation: expected ${expectedHash}, got ${actualHash}`, 'INTEGRITY_VIOLATION');
    this.name = 'IntegrityViolationError';
  }
}

export class EventStoreCorruptedError extends ESAAError {
  constructor(
    public readonly eventSeq: number,
    details: string,
  ) {
    super(`Event store corrupted at seq ${eventSeq}: ${details}`, 'EVENT_STORE_CORRUPTED');
    this.name = 'EventStoreCorruptedError';
  }
}

export class ContractNotFoundError extends ESAAError {
  constructor(
    public readonly actor: string,
  ) {
    super(`No contract found for agent '${actor}'`, 'CONTRACT_NOT_FOUND');
    this.name = 'ContractNotFoundError';
  }
}
