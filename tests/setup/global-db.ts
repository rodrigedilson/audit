import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

  const base = process.env['TEST_DATABASE_URL'];
  if (!base) {
    // Sem banco, as suítes de integração se pulam sozinhas.
    return;
  }

  // No CI o Postgres nasce vazio a cada job: não há schema de outra branch para
  // colidir, e os passos seguintes (`semear-log-de-ci`, `verify`) usam o banco
  // da variável tal como ela é.
  const connectionString = process.env['CI'] ? base : await bancoDoSchema(base);
  // Os workers do vitest nascem depois do globalSetup e herdam o ambiente: é
  // assim que todo arquivo de teste passa a usar o banco deste schema.
  process.env['TEST_DATABASE_URL'] = connectionString;

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

/**
 * Um banco de teste por conjunto de migrations.
 *
 * O Postgres local é um só para todas as worktrees, e cada branch aplica nele as
 * suas migrations. Como elas são idempotentes e não desfazem nada, uma branch
 * que troca uma chave única (a `feat/conciliacao-icms-ipi` trocou a de
 * `sped_files` para incluir `layout`) deixava o banco com o schema dela, e a
 * `main` passava a falhar com `there is no unique or exclusion constraint
 * matching the ON CONFLICT specification` — um erro que não era de código
 * nenhum, e que voltava a cada rodada da outra branch.
 *
 * O nome do banco leva o hash das migrations: branches com as mesmas migrations
 * compartilham o banco, como antes; migration diferente é banco diferente, e o
 * schema de uma não vaza para a outra. O banco é criado na primeira vez.
 */
async function bancoDoSchema(base: string): Promise<string> {
  const dir = join(process.cwd(), 'supabase/migrations');
  const arquivos = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const hash = createHash('sha256');
  for (const arquivo of arquivos) {
    hash.update(arquivo).update('\0').update(await readFile(join(dir, arquivo))).update('\0');
  }

  const url = new URL(base);
  const nome = `${url.pathname.slice(1)}_${hash.digest('hex').slice(0, 12)}`;

  const pool = new pg.Pool({ connectionString: base, max: 1 });
  try {
    const { rowCount } = await pool.query('select 1 from pg_database where datname = $1', [nome]);
    if (rowCount === 0) {
      await pool.query(`create database "${nome}"`).catch((erro: { code?: string }) => {
        // Duas suítes subindo juntas com o mesmo schema: a outra criou primeiro.
        if (erro.code !== '42P04') throw erro;
      });
    }
  } finally {
    await pool.end();
  }

  url.pathname = `/${nome}`;
  return url.toString();
}
