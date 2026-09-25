import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  RETENCAO_EM_DIAS,
  expurgarTrilhaDeSeguranca,
  startSecurityTrailPruner,
} from '../../../src/infrastructure/security/security-trail-retention.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];

/**
 * Trilha sem prazo de descarte não é zelo, é acúmulo: guardaria para sempre o
 * rastro de quem tentou entrar, que é dado pessoal ainda que em HMAC.
 */
describe.skipIf(!DATABASE_URL)('expurgo da trilha de segurança', () => {
  let pool: pg.Pool;

  /** Marca própria: os outros arquivos escrevem na mesma tabela em paralelo. */
  const marca = `expurgo-${process.pid}`;

  const inserir = async (diasAtras: number, quantos = 1): Promise<void> => {
    for (let i = 0; i < quantos; i++) {
      await pool.query(
        `insert into security_events (kind, user_agent, at)
         values ('limite', $1, now() - ($2 || ' days')::interval)`,
        [marca, String(diasAtras)],
      );
    }
  };

  const restantes = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from security_events where user_agent = $1',
      [marca],
    );
    return Number(rows[0]!.n);
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query('delete from security_events where user_agent = $1', [marca]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from security_events where user_agent = $1', [marca]);
  });

  it('apaga o que passou da retenção e preserva o resto', async () => {
    await inserir(RETENCAO_EM_DIAS + 10, 3);
    await inserir(1, 2);

    await expurgarTrilhaDeSeguranca(pool);

    expect(await restantes()).toBe(2);
  });

  /**
   * O limite é a idade, não o volume: apagar "os mais antigos" por contagem
   * descartaria evento de ontem num dia movimentado.
   */
  it('não apaga nada quando tudo está dentro do prazo', async () => {
    await inserir(RETENCAO_EM_DIAS - 1, 4);

    expect(await expurgarTrilhaDeSeguranca(pool)).toBe(0);
    expect(await restantes()).toBe(4);
  });

  it('devolve quantas apagou, para o log dizer o que aconteceu', async () => {
    await inserir(RETENCAO_EM_DIAS + 5, 7);

    expect(await expurgarTrilhaDeSeguranca(pool)).toBe(7);
  });

  it('aceita prazo diferente, que é o que o teste e o ajuste precisam', async () => {
    await inserir(10, 3);

    expect(await expurgarTrilhaDeSeguranca(pool, 5)).toBe(3);
  });

  it('o agendador expurga e avisa quantas foram', async () => {
    await inserir(RETENCAO_EM_DIAS + 1, 2);
    const apagadas: number[] = [];

    const pruner = startSecurityTrailPruner(pool, {
      intervalMs: 10,
      onPurge: (n) => apagadas.push(n),
    });
    await new Promise((r) => setTimeout(r, 150));
    await pruner.stop();

    expect(apagadas[0]).toBeGreaterThanOrEqual(2);
    expect(await restantes()).toBe(0);
  });

  /** Falhar o expurgo não pode derrubar o processo da API. */
  it('o agendador não propaga erro, avisa quem o criou', async () => {
    const poolQuebrado = {
      query: async () => {
        throw new Error('banco fora do ar');
      },
    } as unknown as pg.Pool;
    const erros: unknown[] = [];

    const pruner = startSecurityTrailPruner(poolQuebrado, {
      intervalMs: 10,
      onError: (e) => erros.push(e),
    });
    await new Promise((r) => setTimeout(r, 120));
    await pruner.stop();

    expect(erros.length).toBeGreaterThan(0);
  });
});
