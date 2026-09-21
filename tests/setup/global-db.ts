import pg from 'pg';
import { applyMigrations } from '../helpers/db.js';

/**
 * Aplica as migrations uma única vez, antes de qualquer arquivo de teste.
 *
 * Antes isso ficava no `beforeAll` de cada arquivo, e o vitest roda arquivos em
 * paralelo: dois workers executavam o mesmo DDL ao mesmo tempo. `drop trigger` /
 * `create trigger` e as policies tomam ACCESS EXCLUSIVE na tabela `events`, e
 * dois workers adquirindo esses locks em ordens diferentes produziam
 * `deadlock detected` — que aparecia no teste de concorrência, porque ele é o
 * único que segura um advisory lock enquanto espera lock de tabela.
 *
 * Migrations são setup do banco, não de arquivo de teste. Aqui rodam uma vez.
 */
export async function setup(): Promise<void> {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (!connectionString) {
    // Sem banco, as suítes de integração se pulam sozinhas.
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}
