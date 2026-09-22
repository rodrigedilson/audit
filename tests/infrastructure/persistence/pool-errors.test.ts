import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../../../src/infrastructure/persistence/pool-errors.js';

/**
 * `pg.Pool` é um `EventEmitter`, e é isso que o teste explora: emitir `'error'`
 * num emitter sem listener faz Node lançar. O teste prova que o listener existe
 * e que o processo sobrevive — não é um teste sobre logging.
 */
function poolFalso(): pg.Pool {
  return new EventEmitter() as unknown as pg.Pool;
}

describe('ignorarErroDeClienteOcioso', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * O caso de produção: o Supabase encerra conexão ociosa como operação normal,
   * e sem listener isso derrubava o servidor inteiro. Emitir `'error'` num
   * `EventEmitter` sem listener lança a própria exceção.
   */
  it('um erro de cliente ocioso não derruba o processo', () => {
    const pool = poolFalso();
    ignorarErroDeClienteOcioso(pool, 'TestePool');

    const erro = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });

    expect(() => (pool as unknown as EventEmitter).emit('error', erro)).not.toThrow();
  });

  /** Sem o listener, o mesmo evento lança. É o que a correção evita. */
  it('sem o listener, o mesmo evento lança', () => {
    const pool = poolFalso();

    expect(() => (pool as unknown as EventEmitter).emit('error', new Error('57P01'))).toThrow();
  });

  /** Engolir não é esconder: o erro vai para o log com o código do Postgres. */
  it('registra o erro com o código do Postgres', () => {
    const escrita = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = poolFalso();
    ignorarErroDeClienteOcioso(pool, 'TestePool');

    (pool as unknown as EventEmitter).emit(
      'error',
      Object.assign(new Error('conexão encerrada'), { code: '57P01' }),
    );

    const linhas = [...escrita.mock.calls, ...aviso.mock.calls].flat().join(' ');
    expect(linhas).toContain('57P01');
    expect(linhas).toContain('TestePool');
  });
});
