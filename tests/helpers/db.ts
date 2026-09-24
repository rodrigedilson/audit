import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { digitosVerificadoresDeCnpj } from '../../src/esaa/shared/domain/cnpj.js';

/**
 * Setup de banco para os testes de integração.
 *
 * Nenhuma função aqui dá `truncate`. O vitest roda arquivos de teste em
 * paralelo, e limpar tabelas compartilhadas fazia um arquivo apagar as fixtures
 * do outro — os dois passavam isolados e falhavam juntos. Em vez de serializar a
 * suíte, cada teste trabalha com tenant e CNPJ próprios: como toda consulta é
 * escopada, dados de outro teste são invisíveis por construção.
 *
 * Isso também dispensa apagar eventos, o que seria impossível: o trigger
 * append-only bloqueia DELETE em `events`.
 */
export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const dir = join(process.cwd(), 'supabase/migrations');
  // Ordem lexicográfica é a ordem cronológica: os arquivos são prefixados com
  // timestamp. Aplicar fora de ordem quebraria as FKs.
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();

  for (const file of files) {
    await pool.query(await readFile(join(dir, file), 'utf8'));
  }
}

/** CNPJ sintético de 14 dígitos. Não valida dígito verificador — o banco não exige. */
/**
 * CNPJ numérico aleatório **com dígitos verificadores válidos**.
 *
 * Antes eram 14 dígitos sorteados, o que passava enquanto nada conferia o DV.
 * Com o CNPJ alfanumérico em vigor o cadastro passou a conferir, e um CNPJ
 * inventado seria recusado — além de fazer os testes exercitarem um dado que o
 * sistema não aceita mais.
 */
export function randomCnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('');
  return base + digitosVerificadoresDeCnpj(base);
}

/** CNPJ alfanumérico válido, como os emitidos desde 31/07/2026. */
export function randomCnpjAlfanumerico(): string {
  const alfabeto = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const base = Array.from(
    { length: 12 },
    () => alfabeto[Math.floor(Math.random() * alfabeto.length)]!,
  ).join('');
  return base + digitosVerificadoresDeCnpj(base);
}

export async function createTenant(pool: pg.Pool, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query('insert into tenants (id, name) values ($1, $2)', [id, name]);
  return id;
}

export async function createMembership(
  pool: pg.Pool,
  tenantId: string,
  role: 'owner' | 'accountant' | 'viewer',
): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    'insert into memberships (tenant_id, user_id, role) values ($1, $2::uuid, $3)',
    [tenantId, userId, role],
  );
  return userId;
}

export async function createClient(
  pool: pg.Pool,
  tenantId: string,
  cnpj: string,
  options: { legalName?: string; regime?: string } = {},
): Promise<void> {
  await pool.query(
    `insert into clients (tenant_id, cnpj, legal_name, regime)
     values ($1::uuid, $2::char(14), $3, $4::regime)`,
    [tenantId, cnpj, options.legalName ?? `Cliente ${cnpj}`, options.regime ?? 'simples_hibrido'],
  );
}
