#!/usr/bin/env tsx
/**
 * Prepara um projeto Supabase novo para rodar o audit.
 *
 * Faz, em ordem e de forma idempotente:
 *   1. testa a conexão e explica a falha quando ela é a conhecida (IPv6)
 *   2. aplica todas as migrations de supabase/migrations/
 *   3. cria o escritório (tenant)
 *   4. vincula um usuário do Supabase Auth como `owner`
 *
 * Uso:
 *   npx tsx scripts/setup-supabase.ts --escritorio "Meu Escritório" --email voce@dominio.com.br
 *
 * O e-mail precisa ser de um usuário que já exista em `auth.users` — crie pelo
 * painel (Authentication → Users → Add user, marcando "Auto Confirm User"),
 * porque este projeto está com `mailer_autoconfirm: false` e um cadastro por
 * e-mail fica pendente de confirmação.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

interface Options {
  escritorio: string;
  email: string;
  databaseUrl: string;
}

function parseArgs(argv: readonly string[]): Options {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const escritorio = read('escritorio');
  const email = read('email');
  const databaseUrl = read('database-url') ?? process.env['DATABASE_URL'];

  const faltando: string[] = [];
  if (!escritorio) faltando.push('--escritorio "Nome do Escritório"');
  if (!email) faltando.push('--email voce@dominio.com.br');
  if (!databaseUrl) faltando.push('DATABASE_URL no ambiente ou --database-url');

  if (faltando.length > 0) {
    throw new Error(`Faltam argumentos:\n  ${faltando.join('\n  ')}`);
  }
  if (databaseUrl!.includes('SENHA_DO_BANCO') || databaseUrl!.includes('SUA-REGIAO')) {
    throw new Error(
      'DATABASE_URL ainda tem os marcadores do .env. Copie a string do Session pooler\n' +
        '  no painel do Supabase (Connect → Session pooler) e troque a senha.',
    );
  }

  return { escritorio: escritorio!, email: email!, databaseUrl: databaseUrl! };
}

async function conectar(databaseUrl: string): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  try {
    const { rows } = await pool.query<{ version: string }>('select version()');
    console.log(`  conectado: ${rows[0]!.version.split(' ').slice(0, 2).join(' ')}`);
    return pool;
  } catch (error) {
    await pool.end().catch(() => undefined);
    const causa = error instanceof Error ? error.message : String(error);

    if (causa.includes('ENETUNREACH')) {
      throw new Error(
        `Não foi possível conectar: ${causa}\n\n` +
          '  Esta é a falha conhecida: o host de conexão direta do Supabase\n' +
          '  (db.<ref>.supabase.co) só tem endereço IPv6, e esta máquina não tem\n' +
          '  rota IPv6. Use a string do **Session pooler**, que atende em IPv4:\n' +
          '    postgresql://postgres.<ref>:SENHA@aws-0-<regiao>.pooler.supabase.com:5432/postgres',
      );
    }
    if (causa.includes('password authentication failed')) {
      throw new Error(
        'Senha do banco incorreta. Painel → Project Settings → Database →\n' +
          '  Database password (use "Reset database password" se não souber).\n' +
          '  Lembre de fazer URL-encode de caracteres especiais (@ = %40).',
      );
    }
    throw new Error(`Não foi possível conectar: ${causa}`);
  }
}

async function aplicarMigrations(pool: pg.Pool): Promise<void> {
  const dir = join(process.cwd(), 'supabase/migrations');
  // Ordem lexicográfica é a cronológica: os arquivos são prefixados com
  // timestamp, e aplicar fora de ordem quebraria as chaves estrangeiras.
  const arquivos = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();

  for (const arquivo of arquivos) {
    process.stdout.write(`  ${arquivo} ... `);
    await pool.query(await readFile(join(dir, arquivo), 'utf8'));
    console.log('ok');
  }
}

async function buscarUsuario(pool: pg.Pool, email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string; confirmado: boolean }>(
    `select id, (email_confirmed_at is not null) as confirmado
       from auth.users where lower(email) = lower($1)`,
    [email],
  );

  const usuario = rows[0];
  if (!usuario) {
    throw new Error(
      `Nenhum usuário com e-mail '${email}' em auth.users.\n\n` +
        '  Crie pelo painel: Authentication → Users → Add user,\n' +
        '  marcando "Auto Confirm User" — este projeto está com\n' +
        '  mailer_autoconfirm desligado, então um cadastro comum fica pendente.',
    );
  }

  if (!usuario.confirmado) {
    console.log(
      `  AVISO: o e-mail ainda não foi confirmado. O login vai falhar até confirmar\n` +
        `         (ou marque o usuário como confirmado no painel).`,
    );
  }

  return usuario.id;
}

async function criarEscritorio(pool: pg.Pool, nome: string, userId: string): Promise<string> {
  const { rows: existentes } = await pool.query<{ tenant_id: string; nome: string }>(
    `select m.tenant_id, t.name as nome
       from memberships m join tenants t on t.id = m.tenant_id
      where m.user_id = $1::uuid`,
    [userId],
  );

  const jaTem = existentes[0];
  if (jaTem) {
    console.log(`  usuário já pertence a '${jaTem.nome}' — nada a criar`);
    return jaTem.tenant_id;
  }

  const { rows } = await pool.query<{ id: string }>(
    'insert into tenants (name) values ($1) returning id',
    [nome],
  );
  const tenantId = rows[0]!.id;

  await pool.query(
    `insert into memberships (tenant_id, user_id, role) values ($1::uuid, $2::uuid, 'owner')`,
    [tenantId, userId],
  );

  console.log(`  escritório '${nome}' criado, usuário vinculado como owner`);
  return tenantId;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  console.log('1. conexão');
  const pool = await conectar(options.databaseUrl);

  try {
    console.log('2. migrations');
    await aplicarMigrations(pool);

    console.log('3. usuário');
    const userId = await buscarUsuario(pool, options.email);
    console.log(`  ${options.email} -> ${userId}`);

    console.log('4. escritório');
    const tenantId = await criarEscritorio(pool, options.escritorio, userId);

    console.log('');
    console.log('pronto. tenant_id =', tenantId);
    console.log('');
    console.log('Próximos passos:');
    console.log('  npm run dev                 # sobe a API em http://localhost:3000');
    console.log('  curl localhost:3000/v1/plans   # rota pública, confirma o banco');
    console.log('');
    console.log('  Para obter um token e testar as rotas autenticadas:');
    console.log('    curl -s -X POST localhost:3000/v1/auth/login \\');
    console.log('      -H "Content-Type: application/json" \\');
    console.log(`      -d '{"email":"${options.email}","password":"SUA-SENHA"}'`);
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
