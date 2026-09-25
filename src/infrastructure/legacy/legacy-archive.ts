import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * Cópia de segurança do acervo legado: o que sobrou da fase anterior do produto
 * em produção, e que nenhuma migration deste repositório cria.
 *
 * A regra é **não perder nada**, e ela decide o formato:
 *
 * - **Tudo numa transação só**, `repeatable read` e somente-leitura. As tabelas
 *   saem do mesmo instante do banco; uma cópia montada em momentos diferentes
 *   poderia ter a nota sem os itens.
 * - **Linha como o banco a entrega**, em `to_jsonb`. Nada é convertido nem
 *   interpretado: o que se guarda é o que estava lá.
 * - **Estrutura junto do dado**: colunas, constraints, índices, policies,
 *   gatilhos, a definição da view e as funções que citam as tabelas. Sem ela, o
 *   dado restaurado não teria onde entrar.
 * - **Hash por tabela**, SHA-256 das linhas em ordem canônica. É o que permite
 *   dizer, depois, que a cópia e a origem são iguais — e não "parecem iguais".
 * - **Tabela esperada que não existe é falha**, não aviso. Pular em silêncio é
 *   exatamente como se perde dado.
 */

/** Inventário de `docs/seguranca/CLASSIFICACAO-DE-DADOS.md`, conferido em produção em 25/09/2026. */
export const LEGACY_TABLES = [
  'extracted_invoices',
  'extracted_items',
  'extracted_taxes',
  'extracted_participants',
  'extracted_companies',
  'xml_documents',
  'xml_document_items',
  'xml_import_jobs',
  'sped_parsed_records',
  'sped_parsing_jobs',
  'cross_reference_results',
  'cross_reference_divergences',
  'cross_reference_runs',
  'uploaded_files',
  'entity_extraction_jobs',
  'document_cache',
  'profiles',
  'cfops',
  'ai_analyses',
  'audits',
  'reports',
] as const;

export const LEGACY_VIEWS = ['sped_invoices_for_crossref'] as const;

export class LegacyArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyArchiveError';
  }
}

export interface TableStructure {
  columns: {
    name: string;
    type: string;
    notNull: boolean;
    default: string | null;
  }[];
  constraints: { name: string; definition: string }[];
  indexes: string[];
  policies: {
    name: string;
    command: string;
    using: string | null;
    check: string | null;
  }[];
  triggers: string[];
  rlsEnabled: boolean;
}

export interface TableSnapshot {
  name: string;
  rowCount: number;
  /** SHA-256 das linhas em `to_jsonb(t)::text`, ordenadas por esse texto e unidas por `\n`. */
  sha256: string;
  structure: TableStructure;
  /** Cada linha como o banco a devolveu. */
  rows: string[];
}

export interface ViewSnapshot {
  name: string;
  definition: string;
  rowCount: number;
}

export interface StoredObjectRef {
  bucket: string;
  name: string;
  metadata: unknown;
}

export interface LegacySnapshot {
  takenAt: string;
  schema: string;
  tables: TableSnapshot[];
  views: ViewSnapshot[];
  /** Funções do schema cujo corpo cita alguma tabela legada. */
  functions: { name: string; definition: string }[];
  /** `null` quando o banco não tem o schema `storage` (Postgres puro, fora do Supabase). */
  storageObjects: StoredObjectRef[] | null;
}

export interface SnapshotOptions {
  schema?: string;
  tables?: readonly string[];
  views?: readonly string[];
  /** Índice do storage. Só os testes trocam: fora do Supabase não há `storage.objects`. */
  storageTable?: { schema: string; table: string };
}

/** Identificador SQL seguro: só o que um nome de tabela legítimo tem. */
function ident(nome: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) {
    throw new LegacyArchiveError(`Nome de objeto inesperado: ${JSON.stringify(nome)}.`);
  }
  return `"${nome}"`;
}

/** Hash canônico de um conjunto de linhas já em texto: ordena e une por `\n`. */
export function hashDasLinhas(linhas: readonly string[]): string {
  const ordenadas = [...linhas].sort();
  return createHash('sha256').update(ordenadas.join('\n'), 'utf8').digest('hex');
}

async function estrutura(client: pg.PoolClient, schema: string, tabela: string): Promise<TableStructure> {
  const alvo = `${ident(schema)}.${ident(tabela)}`;
  // Em sequência: é um cliente só, dentro da transação do snapshot.
  const colunas = await client.query<{
    name: string;
    type: string;
    not_null: boolean;
    default: string | null;
  }>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
              pg_get_expr(d.adbin, d.adrelid) as default
         from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    [alvo],
  );
  const constraints = await client.query<{ name: string; definition: string }>(
    `select conname as name, pg_get_constraintdef(oid) as definition
         from pg_constraint where conrelid = $1::regclass order by conname`,
    [alvo],
  );
  const indices = await client.query<{ def: string }>(
    `select pg_get_indexdef(indexrelid) as def from pg_index where indrelid = $1::regclass order by 1`,
    [alvo],
  );
  const policies = await client.query<{
    name: string;
    command: string;
    using: string | null;
    check: string | null;
  }>(
    `select policyname as name, cmd as command, qual as using, with_check as check
         from pg_policies where schemaname = $1 and tablename = $2 order by policyname`,
    [schema, tabela],
  );
  const gatilhos = await client.query<{ def: string }>(
    `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = $1::regclass and not tgisinternal order by tgname`,
    [alvo],
  );
  const rls = await client.query<{ rls: boolean }>(
    `select relrowsecurity as rls from pg_class where oid = $1::regclass`,
    [alvo],
  );
  return {
    columns: colunas.rows.map((c) => ({
      name: c.name,
      type: c.type,
      notNull: c.not_null,
      default: c.default,
    })),
    constraints: constraints.rows,
    indexes: indices.rows.map((r) => r.def),
    policies: policies.rows,
    triggers: gatilhos.rows.map((r) => r.def),
    rlsEnabled: rls.rows[0]?.rls ?? false,
  };
}

/** Linhas da tabela em texto canônico, e o hash delas. Usado no snapshot e na conferência. */
export async function linhasDaTabela(
  client: pg.PoolClient | pg.Pool,
  schema: string,
  tabela: string,
): Promise<{ rows: string[]; sha256: string }> {
  const { rows } = await client.query<{ linha: string }>(
    `select to_jsonb(t)::text as linha from ${ident(schema)}.${ident(tabela)} t order by 1`,
  );
  const linhas = rows.map((r) => r.linha);
  return { rows: linhas, sha256: hashDasLinhas(linhas) };
}

export async function snapshotLegacy(pool: pg.Pool, opcoes: SnapshotOptions = {}): Promise<LegacySnapshot> {
  const schema = opcoes.schema ?? 'public';
  const tabelas = opcoes.tables ?? LEGACY_TABLES;
  const views = opcoes.views ?? LEGACY_VIEWS;
  const storage = opcoes.storageTable ?? { schema: 'storage', table: 'objects' };
  const indiceDoStorage = `${ident(storage.schema)}.${ident(storage.table)}`;

  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');

    const existentes = await client.query<{ nome: string; tipo: string }>(
      `select c.relname as nome, c.relkind::text as tipo from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = any($2::text[])`,
      [schema, [...tabelas, ...views]],
    );
    const tipoDe = new Map(existentes.rows.map((r) => [r.nome, r.tipo]));
    const faltando = [...tabelas, ...views].filter((t) => !tipoDe.has(t));
    if (faltando.length > 0) {
      throw new LegacyArchiveError(
        `Objeto(s) do inventário que não existem em ${schema}: ${faltando.join(', ')}. ` +
          'Nada foi copiado: uma cópia sem eles não seria completa, e dizer o contrário é como se perde dado.',
      );
    }

    const snapshotsDeTabela: TableSnapshot[] = [];
    for (const nome of tabelas) {
      const { rows, sha256 } = await linhasDaTabela(client, schema, nome);
      snapshotsDeTabela.push({
        name: nome,
        rowCount: rows.length,
        sha256,
        structure: await estrutura(client, schema, nome),
        rows,
      });
    }

    const snapshotsDeView: ViewSnapshot[] = [];
    for (const nome of views) {
      const alvo = `${ident(schema)}.${ident(nome)}`;
      const def = await client.query<{ def: string }>(`select pg_get_viewdef($1::regclass, true) as def`, [alvo]);
      const n = await client.query<{ n: number }>(`select count(*)::int as n from ${alvo}`);
      snapshotsDeView.push({
        name: nome,
        definition: def.rows[0]!.def,
        rowCount: n.rows[0]!.n,
      });
    }

    const funcoes = await client.query<{ name: string; definition: string }>(
      `select p.proname as name, pg_get_functiondef(p.oid) as definition
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.prokind in ('f', 'p') and p.prosrc ~ $2
        order by p.proname`,
      [schema, `\\m(${[...tabelas, ...views].join('|')})\\M`],
    );

    const temStorage = await client.query<{ ok: boolean }>(`select to_regclass($1) is not null as ok`, [
      indiceDoStorage,
    ]);
    let storageObjects: StoredObjectRef[] | null = null;
    if (temStorage.rows[0]!.ok) {
      const objetos = await client.query<{
        bucket: string;
        name: string;
        metadata: unknown;
      }>(`select bucket_id as bucket, name, metadata from ${indiceDoStorage} order by bucket_id, name`);
      storageObjects = objetos.rows;
    }

    const agora = await client.query<{ agora: string }>(`select now()::text as agora`);
    await client.query('commit');
    return {
      takenAt: agora.rows[0]!.agora,
      schema,
      tables: snapshotsDeTabela,
      views: snapshotsDeView,
      functions: funcoes.rows,
      storageObjects,
    };
  } catch (erro) {
    await client.query('rollback').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

/** Um objeto do storage já baixado, com o hash do conteúdo. */
export interface DownloadedObject extends StoredObjectRef {
  bytes: Uint8Array;
  sha256: string;
}

export interface ArchiveManifest {
  format: 'audit-legado/1';
  takenAt: string;
  schema: string;
  tables: { name: string; rowCount: number; sha256: string }[];
  views: { name: string; rowCount: number }[];
  functions: string[];
  /** `false` quando o arquivo foi gerado sem o conteúdo dos buckets. Nunca omitido. */
  storageIncluded: boolean;
  objects: { bucket: string; name: string; bytes: number; sha256: string }[];
}

export function manifestoDe(snapshot: LegacySnapshot, objetos: readonly DownloadedObject[] | null): ArchiveManifest {
  return {
    format: 'audit-legado/1',
    takenAt: snapshot.takenAt,
    schema: snapshot.schema,
    tables: snapshot.tables.map((t) => ({
      name: t.name,
      rowCount: t.rowCount,
      sha256: t.sha256,
    })),
    views: snapshot.views.map((v) => ({ name: v.name, rowCount: v.rowCount })),
    functions: snapshot.functions.map((f) => f.name),
    storageIncluded: objetos !== null,
    objects: (objetos ?? []).map((o) => ({
      bucket: o.bucket,
      name: o.name,
      bytes: o.bytes.length,
      sha256: o.sha256,
    })),
  };
}

/**
 * O conteúdo do arquivo, antes da cifra: JSON por linha. A primeira é o
 * manifesto; depois a estrutura de cada tabela, as linhas (cada uma com o texto
 * exato de `to_jsonb`), as views, as funções e os objetos do storage em base64.
 */
export function registrosDoArquivo(snapshot: LegacySnapshot, objetos: readonly DownloadedObject[] | null): string {
  const saida: string[] = [
    JSON.stringify({
      type: 'manifest',
      manifest: manifestoDe(snapshot, objetos),
    }),
  ];
  for (const t of snapshot.tables) {
    saida.push(JSON.stringify({ type: 'table', name: t.name, structure: t.structure }));
    // A linha vai como texto, e não como objeto: `1.50` numa coluna numeric
    // voltaria `1.5` depois de um JSON.parse, e a cópia deixaria de ser idêntica.
    for (const linha of t.rows) saida.push(JSON.stringify({ type: 'row', table: t.name, text: linha }));
  }
  for (const v of snapshot.views) saida.push(JSON.stringify({ type: 'view', ...v }));
  for (const f of snapshot.functions) saida.push(JSON.stringify({ type: 'function', ...f }));
  if (snapshot.storageObjects !== null) {
    saida.push(
      JSON.stringify({
        type: 'storage_index',
        objects: snapshot.storageObjects,
      }),
    );
  }
  for (const o of objetos ?? []) {
    saida.push(
      JSON.stringify({
        type: 'object',
        bucket: o.bucket,
        name: o.name,
        sha256: o.sha256,
        base64: Buffer.from(o.bytes).toString('base64'),
      }),
    );
  }
  return saida.join('\n') + '\n';
}

export interface ArchiveCheck {
  manifest: ArchiveManifest;
  problems: string[];
}

/**
 * Relê o conteúdo e refaz cada hash a partir do que está **no arquivo**: as
 * linhas de cada tabela e os bytes de cada objeto. Arquivo que passa aqui é
 * arquivo que se restaura.
 */
export function conferirConteudo(conteudo: string): ArchiveCheck {
  const linhas = conteudo.split('\n').filter((l) => l !== '');
  const primeira = JSON.parse(linhas[0] ?? '{}') as {
    type?: string;
    manifest?: ArchiveManifest;
  };
  if (primeira.type !== 'manifest' || primeira.manifest?.format !== 'audit-legado/1') {
    throw new LegacyArchiveError('O arquivo não começa pelo manifesto audit-legado/1.');
  }
  const manifest = primeira.manifest;
  const porTabela = new Map<string, string[]>();
  const objetos = new Map<string, string>();
  const estruturas = new Set<string>();

  for (const linha of linhas.slice(1)) {
    const r = JSON.parse(linha) as {
      type: string;
      table?: string;
      text?: string;
      name?: string;
      bucket?: string;
      base64?: string;
    };
    if (r.type === 'row') {
      const lista = porTabela.get(r.table!) ?? [];
      lista.push(r.text!);
      porTabela.set(r.table!, lista);
    } else if (r.type === 'table') {
      estruturas.add(r.name!);
    } else if (r.type === 'object') {
      objetos.set(`${r.bucket}/${r.name}`, createHash('sha256').update(Buffer.from(r.base64!, 'base64')).digest('hex'));
    }
  }

  const problems: string[] = [];
  for (const t of manifest.tables) {
    if (!estruturas.has(t.name)) problems.push(`${t.name}: a estrutura não está no arquivo.`);
    const lista = porTabela.get(t.name) ?? [];
    if (lista.length !== t.rowCount)
      problems.push(`${t.name}: ${lista.length} linha(s) no arquivo, ${t.rowCount} no manifesto.`);
    const sha = hashDasLinhas(lista);
    if (sha !== t.sha256) problems.push(`${t.name}: o hash das linhas não confere com o manifesto.`);
  }
  for (const o of manifest.objects) {
    const sha = objetos.get(`${o.bucket}/${o.name}`);
    if (sha === undefined) problems.push(`${o.bucket}/${o.name}: o objeto não está no arquivo.`);
    else if (sha !== o.sha256) problems.push(`${o.bucket}/${o.name}: o hash do conteúdo não confere.`);
  }
  return { manifest, problems };
}
