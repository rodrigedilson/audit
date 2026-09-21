import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, parseDotEnv } from '../../src/config/dotenv.js';

describe('parseDotEnv', () => {
  it('lê atribuição simples', () => {
    expect(parseDotEnv('API_PORT=3000')).toEqual([['API_PORT', '3000']]);
  });

  it('ignora linhas vazias e comentários', () => {
    const conteudo = ['# comentário', '', '   ', 'A=1', '  # outro', 'B=2'].join('\n');

    expect(parseDotEnv(conteudo)).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('aceita o prefixo export, que aparece em .env copiado de shell', () => {
    expect(parseDotEnv('export TOKEN=abc')).toEqual([['TOKEN', 'abc']]);
  });

  it('tolera espaços em volta do igual', () => {
    expect(parseDotEnv('A = 1')).toEqual([['A', '1']]);
  });

  /**
   * O caso que motivou o parser próprio: valores reais desta aplicação têm `=`
   * dentro. Um JWT termina em `=` de padding, e uma senha pode ter qualquer
   * coisa.
   */
  it('preserva `=` dentro do valor', () => {
    expect(parseDotEnv('JWT=eyJhbGci.eyJzdWIi.abc==')).toEqual([
      ['JWT', 'eyJhbGci.eyJzdWIi.abc=='],
    ]);
  });

  it('preserva a URL de conexão inteira, com senha e porta', () => {
    const url = 'postgresql://postgres:s3nh%40@db.exemplo.supabase.co:5432/postgres';

    expect(parseDotEnv(`DATABASE_URL=${url}`)).toEqual([['DATABASE_URL', url]]);
  });

  describe('aspas', () => {
    it('remove aspas duplas e interpreta escapes', () => {
      expect(parseDotEnv('A="linha1\\nlinha2"')).toEqual([['A', 'linha1\nlinha2']]);
    });

    it('remove aspas simples sem interpretar escapes', () => {
      expect(parseDotEnv("A='linha1\\nlinha2'")).toEqual([['A', 'linha1\\nlinha2']]);
    });

    it('aceita aspas escapadas dentro de aspas duplas', () => {
      expect(parseDotEnv('A="diz \\"oi\\""')).toEqual([['A', 'diz "oi"']]);
    });

    it('valor vazio entre aspas é string vazia, não ausência', () => {
      expect(parseDotEnv('A=""')).toEqual([['A', '']]);
    });
  });

  describe('comentário de fim de linha', () => {
    it('corta comentário depois de espaço', () => {
      expect(parseDotEnv('A=1 # porta padrão')).toEqual([['A', '1']]);
    });

    /**
     * Exige o espaço antes do `#` justamente para não mutilar senha com `#`,
     * que é o caractere especial mais comum em senha gerada.
     */
    it('NÃO corta `#` colado ao valor', () => {
      expect(parseDotEnv('SENHA=abc#123')).toEqual([['SENHA', 'abc#123']]);
    });

    it('dentro de aspas, `#` é conteúdo', () => {
      expect(parseDotEnv('SENHA="abc #123"')).toEqual([['SENHA', 'abc #123']]);
    });
  });

  it('ignora linha sem igual, em vez de estourar', () => {
    expect(parseDotEnv('isto nao e atribuicao\nA=1')).toEqual([['A', '1']]);
  });

  it('ignora chave com caractere inválido', () => {
    expect(parseDotEnv('9INVALIDA=1\nA-B=2\nVALIDA_2=3')).toEqual([['VALIDA_2', '3']]);
  });

  it('valor sem nada depois do igual é string vazia', () => {
    expect(parseDotEnv('A=')).toEqual([['A', '']]);
  });

  it('aceita CRLF, que é o que um editor no Windows grava', () => {
    expect(parseDotEnv('A=1\r\nB=2\r\n')).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });
});

describe('loadDotEnv', () => {
  let dir: string;
  let alvo: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dotenv-'));
    alvo = {};
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  const escrever = async (conteudo: string): Promise<string> => {
    const caminho = join(dir, '.env');
    await writeFile(caminho, conteudo, 'utf8');
    return caminho;
  };

  it('carrega as variáveis do arquivo', async () => {
    const caminho = await escrever('A=1\nB=2');

    const r = loadDotEnv(caminho, alvo);

    expect(alvo).toEqual({ A: '1', B: '2' });
    expect(r).toMatchObject({ found: true, loaded: ['A', 'B'], skipped: [] });
  });

  /**
   * É a regra que evita "funciona na minha máquina": um `.env` esquecido não
   * pode sobrepor a variável que a plataforma injetou em produção.
   */
  it('o ambiente real tem precedência sobre o arquivo', async () => {
    alvo['A'] = 'do-ambiente';
    const caminho = await escrever('A=do-arquivo\nB=2');

    const r = loadDotEnv(caminho, alvo);

    expect(alvo['A']).toBe('do-ambiente');
    expect(alvo['B']).toBe('2');
    expect(r.skipped).toEqual(['A']);
    expect(r.loaded).toEqual(['B']);
  });

  it('arquivo ausente é situação normal, não erro', () => {
    const r = loadDotEnv(join(dir, 'nao-existe'), alvo);

    expect(r).toEqual({ found: false, loaded: [], skipped: [] });
    expect(alvo).toEqual({});
  });

  it('arquivo só com comentários carrega nada, sem erro', async () => {
    const caminho = await escrever('# nada aqui\n\n');

    expect(loadDotEnv(caminho, alvo)).toMatchObject({ found: true, loaded: [] });
  });

  it('não polui process.env quando um alvo é passado', async () => {
    const caminho = await escrever('VARIAVEL_QUE_NAO_DEVE_VAZAR=1');

    loadDotEnv(caminho, alvo);

    expect(process.env['VARIAVEL_QUE_NAO_DEVE_VAZAR']).toBeUndefined();
  });

  it('carrega um .env realista desta aplicação', async () => {
    const caminho = await escrever(
      [
        '# --- API ---',
        'API_PORT=3000',
        '',
        '# --- Banco ---',
        'DATABASE_URL=postgresql://postgres.ref:s3nh%40@aws-0-sa-east-1.pooler.supabase.com:5432/postgres',
        '',
        'SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc==',
        'CERTIFICATE_MASTER_KEY="cjbtlkhbCLL1WclDZ6Jh4gb7Lzxb+BuDeTJhtIqmxj8v"',
        'LOG_LEVEL=info # silent em teste',
      ].join('\n'),
    );

    loadDotEnv(caminho, alvo);

    expect(alvo['API_PORT']).toBe('3000');
    expect(alvo['DATABASE_URL']).toContain('s3nh%40@aws-0-sa-east-1');
    expect(alvo['SUPABASE_ANON_KEY']).toMatch(/==$/);
    expect(alvo['CERTIFICATE_MASTER_KEY']).toBe('cjbtlkhbCLL1WclDZ6Jh4gb7Lzxb+BuDeTJhtIqmxj8v');
    expect(alvo['LOG_LEVEL']).toBe('info');
  });
});
