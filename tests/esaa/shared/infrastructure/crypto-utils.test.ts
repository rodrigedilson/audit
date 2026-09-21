import { describe, it, expect } from 'vitest';
import {
  sha256,
  canonicalize,
  hashProjection,
} from '../../../../src/esaa/shared/infrastructure/crypto-utils.js';

/**
 * Estes testes existem por causa do ADR-005. A implementação anterior de
 * `canonicalize` usava o 2º argumento do `JSON.stringify` como se fosse um
 * ordenador de chaves, quando na verdade é um allowlist recursivo: todo objeto
 * aninhado serializava vazio e o hash da projeção ficava cego a mudanças em
 * `tasks`, `run`, `issues` e `stats`. Como o hash é a trilha de defesa do produto,
 * a regressão tem de falhar alto.
 */
describe('canonicalize', () => {
  it('serializa objetos aninhados por inteiro, não vazios', () => {
    const canonical = canonicalize({ run: { run_id: 'r1' }, tasks: { 'T-1': { state: 'done' } } });

    expect(canonical).toBe('{"run":{"run_id":"r1"},"tasks":{"T-1":{"state":"done"}}}');
    // A saída da implementação quebrada era '{"run":{},"tasks":{}}'.
    expect(canonical).not.toContain('"run":{}');
    expect(canonical).not.toContain('"tasks":{}');
  });

  it('ordena chaves em todos os níveis, não só no topo', () => {
    const a = canonicalize({ b: { z: 1, a: 2 }, a: { y: 3, b: 4 } });
    const b = canonicalize({ a: { b: 4, y: 3 }, b: { a: 2, z: 1 } });

    expect(a).toBe(b);
    expect(a).toBe('{"a":{"b":4,"y":3},"b":{"a":2,"z":1}}');
  });

  it('preserva a ordem dos arrays, que é significativa', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 2, 1])).not.toBe(canonicalize([1, 2, 3]));
  });

  it('omite chaves sem representação em JSON e mantém o buraco em arrays', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('honra toJSON, mantendo Date estável', () => {
    const iso = '2027-01-31T12:00:00.000Z';
    expect(canonicalize({ at: new Date(iso) })).toBe(`{"at":"${iso}"}`);
  });

  it('rejeita referência circular em vez de estourar a pilha', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;

    expect(() => canonicalize(cyclic)).toThrow(/circular/i);
  });

  it('rejeita número não finito, que numa apuração é defeito de cálculo', () => {
    expect(() => canonicalize({ due_brl: Number.NaN })).toThrow(/não finito/i);
    expect(() => canonicalize({ due_brl: Number.POSITIVE_INFINITY })).toThrow(/não finito/i);
  });

  it('serializa os primitivos de topo', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(1.5)).toBe('1.5');
  });
});

describe('hashProjection', () => {
  const projection = {
    schema_version: '0.4.0',
    last_event_seq: 3,
    last_updated: '2027-01-31T12:00:00.000Z',
    run: { run_id: 'r1', status: 'active' },
    tasks: { 'T-1': { state: 'done', kind: 'impl' } },
    issues: [{ issue_id: 'i1', severity: 'high' }],
    stats: { total: 1, done: 1, todo: 0 },
  };

  const tamperings: ReadonlyArray<readonly [string, (p: typeof projection) => void]> = [
    ['estado de uma task', (p) => void (p.tasks['T-1']!.state = 'todo')],
    ['um total das stats', (p) => void (p.stats.done = 0)],
    ['o status do run', (p) => void (p.run.status = 'failed')],
    ['a severidade de uma issue', (p) => void (p.issues[0]!.severity = 'low')],
  ];

  it.each(tamperings)('detecta adulteração de %s', (_label, tamper) => {
    const original = hashProjection(projection);
    const tampered = structuredClone(projection);
    tamper(tampered);

    // Este era exatamente o caso que a implementação quebrada não pegava.
    expect(hashProjection(tampered)).not.toBe(original);
  });

  it('é estável entre duas execuções e independente da ordem das chaves', () => {
    const reordered = {
      stats: { todo: 0, done: 1, total: 1 },
      issues: [{ severity: 'high', issue_id: 'i1' }],
      tasks: { 'T-1': { kind: 'impl', state: 'done' } },
      run: { status: 'active', run_id: 'r1' },
      last_updated: '2027-01-31T12:00:00.000Z',
      last_event_seq: 3,
      schema_version: '0.4.0',
    };

    expect(hashProjection(projection)).toBe(hashProjection(projection));
    expect(hashProjection(reordered)).toBe(hashProjection(projection));
  });

  it('devolve um SHA-256 hexadecimal de 64 caracteres', () => {
    expect(hashProjection(projection)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256', () => {
  it('produz o digest conhecido da string vazia', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
