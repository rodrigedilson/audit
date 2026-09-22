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
  recusarBancoDeProducao();

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

/**
 * Recusa rodar a suíte com `DATABASE_URL` apontando para outro banco.
 *
 * Isto aconteceu de verdade: `bootstrap()` escolhe o Postgres quando há
 * `DATABASE_URL` no ambiente, e rodar os testes com o `.env` carregado gravou
 * quatro `client.enrolled` no log de **produção**, sob o `TEST_SCOPE` fixo. O
 * log é append-only — não há como desfazer.
 *
 * O teste que causou isso já força o caminho JSONL, mas depender de cada teste
 * lembrar disso é frágil: a próxima chamada a `bootstrap()` num teste novo
 * repetiria o acidente em silêncio. Aqui a suíte inteira se recusa a começar.
 */
function recusarBancoDeProducao(): void {
  const producao = process.env['DATABASE_URL'];
  const teste = process.env['TEST_DATABASE_URL'];

  if (!producao || producao === teste) {
    return;
  }

  throw new Error(
    [
      'DATABASE_URL está definida e aponta para um banco diferente de',
      'TEST_DATABASE_URL. A suíte não roda assim: qualquer teste que chame',
      'bootstrap() escreveria no event log desse banco, e o log é append-only.',
      '',
      'Rode exportando só a variável de teste, por exemplo:',
      '  TEST_DATABASE_URL=postgres://audit:audit@localhost:55432/audit_test npm test',
    ].join('\n'),
  );
}
