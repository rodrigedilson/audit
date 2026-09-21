import type { RejectionReason } from '../../../fiscal/shared/fiscal-vocabulary.js';

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

/**
 * INV-001: competência confirmada é terminal. A correção não reabre o período —
 * emite `rectification.filed` e abre uma competência de retificação vinculada,
 * preservando o hash original.
 */
export class ClosedPeriodViolationError extends ESAAError {
  constructor(
    public readonly period: string,
    public readonly cnpj: string,
  ) {
    super(
      `Competência ${period} do CNPJ ${cnpj} está confirmada e não pode ser alterada. ` +
        'Use uma retificação.',
      'CLOSED_PERIOD_VIOLATION',
    );
    this.name = 'ClosedPeriodViolationError';
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
    public readonly entityId: string,
    public readonly fromState: string,
    public readonly toState: string,
  ) {
    super(
      `Transição inválida para ${entityId}: ${fromState} → ${toState}`,
      'INVALID_TRANSITION',
    );
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
