import { createHash } from 'node:crypto';

export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

export function hashProjection(projection: unknown): string {
  const canonical = canonicalize(projection);
  return sha256(canonical);
}
