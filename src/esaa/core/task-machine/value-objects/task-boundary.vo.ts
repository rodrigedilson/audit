import { ValueObject } from '../../../shared/domain/value-object.js';
import { BoundaryViolationError } from '../../../shared/types/esaa-errors.js';

interface TaskBoundaryProps {
  readable: string[];
  writable: string[];
  forbidden: string[];
}

export class TaskBoundary extends ValueObject<TaskBoundaryProps> {
  private constructor(props: TaskBoundaryProps) {
    super(props);
  }

  static create(readable: string[], writable: string[], forbidden: string[]): TaskBoundary {
    return new TaskBoundary({
      readable: readable.map(normalizePath),
      writable: writable.map(normalizePath),
      forbidden: forbidden.map(normalizePath),
    });
  }

  canRead(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.isForbidden(normalized)) {
      return false;
    }
    if (this.props.readable.length === 0) return true;
    return this.props.readable.some((p) => normalized.startsWith(p));
  }

  canWrite(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.isForbidden(normalized)) {
      return false;
    }
    return this.props.writable.some((p) => normalized.startsWith(p));
  }

  assertCanWrite(path: string, actor: string): void {
    if (!this.canWrite(path)) {
      throw new BoundaryViolationError(actor, path, 'write');
    }
  }

  private isForbidden(normalizedPath: string): boolean {
    return this.props.forbidden.some((p) => normalizedPath.startsWith(p));
  }
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  if (!normalized.endsWith('/') && !normalized.includes('.')) {
    normalized += '/';
  }
  return normalized;
}
