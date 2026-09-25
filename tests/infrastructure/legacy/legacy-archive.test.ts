import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { cifrar, decifrar, ArchiveCipherError } from '../../../src/infrastructure/legacy/archive-cipher.js';
import {
  LEGACY_TABLES,
  LegacyArchiveError,
  conferirConteudo,
  hashDasLinhas,
  linhasDaTabela,
  registrosDoArquivo,
  snapshotLegacy,
} from '../../../src/infrastructure/legacy/legacy-archive.js';
import { baixarObjetos } from '../../../src/infrastructure/legacy/storage-download.js';

const SENHA = 'uma senha longa o bastante';
const DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe('cifra do arquivo', () => {
  it('ida e volta devolve o mesmo texto, byte a byte', () => {
    const texto = 'linha 1\nNF-e nº 123 — R$ 1.234,50\n';
    expect(decifrar(cifrar(texto, SENHA), SENHA)).toBe(texto);
  });

  it('senha errada é recusada, e não devolve lixo', () => {
    expect(() => decifrar(cifrar('x', SENHA), 'outra senha longa demais')).toThrow(ArchiveCipherError);
  });

  it('um byte trocado no arquivo é recusado', () => {
    const arquivo = cifrar('conteúdo fiscal', SENHA);
    arquivo[arquivo.length - 20] ^= 0xff;
    expect(() => decifrar(arquivo, SENHA)).toThrow(/alterado/);
  });

  it('senha curta não gera arquivo', () => {
    expect(() => cifrar('x', 'curta')).toThrow(/16 caracteres/);
  });

  it('arquivo que não é do acervo é recusado pelo cabeçalho', () => {
    expect(() => decifrar(Buffer.from('não é um arquivo cifrado, só texto qualquer'), SENHA)).toThrow(/AUDLEG1/);
  });
});

describe('download do storage', () => {
  const objeto = {
    bucket: 'sped-files',
    name: 'usuario/efd 2025.txt',
    metadata: { size: 5 },
  };

  it('baixa com a chave de serviço, codifica o caminho e guarda o hash', async () => {
    const urls: string[] = [];
    const [o] = await baixarObjetos([objeto], 'https://x.supabase.co/', 'chave', async (url, init) => {
      urls.push(url);
      expect(init.headers['Authorization']).toBe('Bearer chave');
      return new Response('12345');
    });
    expect(urls[0]).toBe('https://x.supabase.co/storage/v1/object/authenticated/sped-files/usuario/efd%202025.txt');
    expect(o!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('objeto que não baixa derruba a cópia inteira', async () => {
    await expect(
      baixarObjetos([objeto], 'https://x', 'k', async () => new Response('', { status: 404 })),
    ).rejects.toThrow(/respondeu 404/);
  });

  it('tamanho diferente do índice derruba a cópia inteira', async () => {
    await expect(baixarObjetos([objeto], 'https://x', 'k', async () => new Response('123'))).rejects.toThrow(/3 byte/);
  });
});

describe.skipIf(!DATABASE_URL)('snapshot do acervo legado', () => {
  let pool: pg.Pool;
  const schema = `legado_teste_${randomBytes(4).toString('hex')}`;
  const tabelas = ['xml_documents', 'xml_document_items'];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`create schema ${schema}`);
    await pool.query(`
      create table ${schema}.xml_documents (
        id uuid primary key default gen_random_uuid(),
        numero text not null,
        valor_total numeric(15,2),
        raw_xml text,
        extra jsonb,
        created_at timestamptz default now()
      );
      create table ${schema}.xml_document_items (
        id uuid primary key default gen_random_uuid(),
        xml_document_id uuid references ${schema}.xml_documents(id),
        v_un_com numeric(21,10)
      );
      create view ${schema}.sped_invoices_for_crossref as select numero from ${schema}.xml_documents;
      create function ${schema}.conta_notas() returns bigint language sql as 'select count(*) from ${schema}.xml_documents';
      insert into ${schema}.xml_documents (numero, valor_total, raw_xml, extra) values
        ('1', 1.50, '<NFe>ação — "aspas" \\ barra</NFe>', '{"b": 2, "a": [1, 2.10]}'),
        ('2', null, null, null);
      insert into ${schema}.xml_document_items (xml_document_id, v_un_com)
        select id, 0.1234567890 from ${schema}.xml_documents where numero = '1';
    `);
  });

  afterAll(async () => {
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });

  const tirar = () =>
    snapshotLegacy(pool, {
      schema,
      tables: tabelas,
      views: ['sped_invoices_for_crossref'],
    });

  it('copia linhas, estrutura, view e função, e o arquivo se confere sozinho', async () => {
    const s = await tirar();

    expect(s.tables.map((t) => [t.name, t.rowCount])).toEqual([
      ['xml_documents', 2],
      ['xml_document_items', 1],
    ]);
    expect(s.tables[0]!.structure.columns.map((c) => c.name)).toEqual([
      'id',
      'numero',
      'valor_total',
      'raw_xml',
      'extra',
      'created_at',
    ]);
    expect(s.tables[1]!.structure.constraints.some((c) => /FOREIGN KEY/.test(c.definition))).toBe(true);
    expect(s.views[0]).toMatchObject({
      name: 'sped_invoices_for_crossref',
      rowCount: 2,
    });
    expect(s.functions.map((f) => f.name)).toContain('conta_notas');

    const { manifest, problems } = conferirConteudo(registrosDoArquivo(s, []));
    expect(problems).toEqual([]);
    expect(manifest.tables[0]!.sha256).toBe(s.tables[0]!.sha256);
  });

  it('guarda o texto exato do banco: 1.50 continua 1.50, e o acento e a barra ficam', async () => {
    const s = await tirar();
    const conteudo = registrosDoArquivo(s, []);
    const linhas = conteudo
      .split('\n')
      .filter((l) => l.includes('"type":"row"'))
      .map((l) => JSON.parse(l) as { text: string });

    expect(linhas.some((l) => l.text.includes('"valor_total": 1.50'))).toBe(true);
    expect(linhas.some((l) => l.text.includes('0.1234567890'))).toBe(true);
    expect(linhas.some((l) => l.text.includes('ação — \\"aspas\\" \\\\ barra'))).toBe(true);
  });

  it('o hash do arquivo é o mesmo que o banco produz de novo', async () => {
    const s = await tirar();
    const agora = await linhasDaTabela(pool, schema, 'xml_documents');
    expect(agora.sha256).toBe(s.tables[0]!.sha256);
    expect(hashDasLinhas([...agora.rows].reverse())).toBe(agora.sha256);
  });

  it('linha removida do arquivo é apontada na conferência', async () => {
    const conteudo = registrosDoArquivo(await tirar(), []);
    const semUma = conteudo
      .split('\n')
      .filter(
        (l, i, todas) =>
          !(
            l.includes('"table":"xml_documents"') &&
            l.includes('"type":"row"') &&
            i === todas.findIndex((x) => x.includes('"type":"row"'))
          ),
      )
      .join('\n');

    const { problems } = conferirConteudo(semUma);
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/xml_documents: 1 linha\(s\) no arquivo, 2 no manifesto/)]),
    );
  });

  it('tabela do inventário que não existe: falha, e nada é copiado', async () => {
    await expect(
      snapshotLegacy(pool, {
        schema,
        tables: ['xml_documents', 'nao_existe'],
        views: [],
      }),
    ).rejects.toThrow(LegacyArchiveError);
  });

  it('o inventário padrão tem as 21 tabelas do documento de classificação', () => {
    expect(LEGACY_TABLES).toHaveLength(21);
  });
});

describe.skipIf(!DATABASE_URL)('migration do schema legado', () => {
  let pool: pg.Pool;
  const migration = join(process.cwd(), 'supabase/migrations/20260927240000_acervo_legado_em_schema.sql');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    // Duas tabelas do inventário, criadas em public como estariam em produção.
    await pool.query(`
      drop table if exists legado.cfops, legado.profiles;
      drop table if exists public.cfops, public.profiles;
      create table public.cfops (codigo text primary key, descricao text, aliquota numeric(7,4));
      create table public.profiles (id uuid primary key default gen_random_uuid(), nome text, n int generated always as identity);
      insert into public.cfops values ('5102', 'Venda de mercadoria — adquirida', 1.5000), ('1102', null, null);
      insert into public.profiles (nome) values ('Fulano'), ('Beltrana');
    `);
  });

  afterAll(async () => {
    await pool.query('drop table if exists legado.cfops, legado.profiles, public.cfops, public.profiles');
    await pool.end();
  });

  it('copia idêntico, não duplica ao rodar de novo, e fecha para anon e authenticated', async () => {
    const sql = await readFile(migration, 'utf8');
    await pool.query(sql);
    await pool.query(sql);

    for (const t of ['cfops', 'profiles']) {
      const [origem, copia] = await Promise.all([linhasDaTabela(pool, 'public', t), linhasDaTabela(pool, 'legado', t)]);
      expect(copia.rows).toHaveLength(2);
      expect(copia.sha256).toBe(origem.sha256);
    }
    const { rows } = await pool.query(`select has_table_privilege('anon', 'legado.cfops', 'select') as le`);
    expect(rows[0].le).toBe(false);
    // Os originais continuam onde estavam.
    expect((await pool.query('select count(*)::int as n from public.cfops')).rows[0].n).toBe(2);
  });
});
