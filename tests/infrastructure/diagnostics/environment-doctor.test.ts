import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  diagnosticar,
  classificarFalhaDeConexao,
} from '../../../src/infrastructure/diagnostics/environment-doctor.js';
import { applyMigrations } from '../../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** Variáveis mínimas para o doctor passar da primeira checagem. */
const ENV_BASE = {
  SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
  SUPABASE_ANON_KEY: 'chave-anon-de-teste',
  SUPABASE_JWT_SECRET: 'segredo-de-teste',
  CERTIFICATE_MASTER_KEY: 'chave-mestra-de-teste-com-mais-de-32-caracteres',
  LOG_LEVEL: 'silent',
} as const;

const checagem = (resultado: Awaited<ReturnType<typeof diagnosticar>>, nome: string) =>
  resultado.checagens.find((c) => c.nome === nome);

describe('diagnosticar — sem precisar de banco', () => {
  it('reporta todas as variáveis faltando de uma vez, em vez de uma por execução', async () => {
    const resultado = await diagnosticar({} as NodeJS.ProcessEnv);

    expect(resultado.ok).toBe(false);
    const env = checagem(resultado, 'variáveis de ambiente');
    expect(env?.estado).toBe('falha');
    expect(env?.detalhe).toContain('DATABASE_URL');
    expect(env?.detalhe).toContain('SUPABASE_URL');
    expect(env?.detalhe).toContain('CERTIFICATE_MASTER_KEY');
    expect(env?.acao).toMatch(/docs\/setup\/SUPABASE\.md/);
  });

  it('para na primeira checagem quando o ambiente está vazio, sem tentar conectar', async () => {
    const resultado = await diagnosticar({} as NodeJS.ProcessEnv);

    // Sem DATABASE_URL não há o que conectar; seguir adiante só produziria
    // erros derivados que escondem a causa.
    expect(resultado.checagens).toHaveLength(1);
  });

  // Timeout folgado: resolver um host inexistente pode levar segundos, e é o
  // próprio caminho que este teste exercita.
  it('não segue para as checagens de schema quando a conexão falha', async () => {
    const resultado = await diagnosticar({
      ...ENV_BASE,
      DATABASE_URL: 'postgresql://u:p@host-que-nao-existe.invalid:5432/postgres',
    } as NodeJS.ProcessEnv);

    expect(checagem(resultado, 'conexão com o banco')?.estado).toBe('falha');
    expect(checagem(resultado, 'schema')).toBeUndefined();
  }, 20_000);
});

/**
 * As mensagens abaixo são as reais, colhidas de cada falha ao configurar este
 * projeto. Testar a classificação em vez de reproduzir a condição de rede é o
 * que mantém o teste estável: um literal IPv6 sem rota dá ENOTFOUND no
 * resolvedor, não o ENETUNREACH que o host real produz.
 */
describe('classificarFalhaDeConexao', () => {
  it('ENETUNREACH aponta o IPv6 do host direto do Supabase', () => {
    const c = classificarFalhaDeConexao(
      'connect ENETUNREACH 2600:1f18:5905:6801:a528:113c:270f:8c3a:5432 - Local (:::0)',
    );

    expect(c.estado).toBe('falha');
    expect(c.acao).toMatch(/IPv6/);
    expect(c.acao).toMatch(/pooler/);
  });

  it('ENOTFOUND aponta erro de nome, não de rede', () => {
    const c = classificarFalhaDeConexao('getaddrinfo ENOTFOUND db.projeto-errado.supabase.co');

    expect(c.acao).toMatch(/não resolve no DNS/);
    expect(c.acao).not.toMatch(/IPv6/);
  });

  it('senha errada aponta o URL-encode, causa comum e silenciosa', () => {
    const c = classificarFalhaDeConexao('password authentication failed for user "postgres"');

    expect(c.acao).toMatch(/URL-encode/);
    expect(c.acao).toMatch(/Reset database password/);
  });

  it('timeout aponta firewall e porta', () => {
    const c = classificarFalhaDeConexao('connect ETIMEDOUT 1.2.3.4:6543');

    expect(c.acao).toMatch(/5432/);
    expect(c.acao).toMatch(/6543/);
  });

  it('banco inexistente aponta o nome no fim da URL', () => {
    const c = classificarFalhaDeConexao('database "audit" does not exist');

    expect(c.acao).toMatch(/postgres/);
  });

  it('erro desconhecido ainda devolve uma ação, não silêncio', () => {
    const c = classificarFalhaDeConexao('algo totalmente inesperado');

    expect(c.acao).toBeDefined();
    expect(c.detalhe).toBe('algo totalmente inesperado');
  });
});

describe.skipIf(!DATABASE_URL)('diagnosticar — contra banco real', () => {
  let admin: pg.Pool;
  let baseVazia: string;
  let urlVazia: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

    // Nome único: os arquivos de teste rodam em paralelo, e um nome fixo faria
    // um arquivo derrubar a base do outro.
    baseVazia = `doctor_${Math.random().toString(36).slice(2, 10)}`;
    await admin.query(`create database ${baseVazia}`);
    urlVazia = DATABASE_URL!.replace(/\/[^/]+$/, `/${baseVazia}`);
  });

  afterAll(async () => {
    await admin.query(`drop database if exists ${baseVazia} with (force)`).catch(() => undefined);
    await admin.end();
  });

  it('conecta e identifica o Postgres', async () => {
    const resultado = await diagnosticar({
      ...ENV_BASE,
      DATABASE_URL,
    } as NodeJS.ProcessEnv);

    const conexao = checagem(resultado, 'conexão com o banco');
    expect(conexao?.estado).toBe('ok');
    expect(conexao?.detalhe).toMatch(/PostgreSQL/);
  });

  describe('banco sem nenhuma migration', () => {
    it('lista as tabelas faltando e os arquivos a rodar', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      const schema = checagem(resultado, 'schema');
      expect(schema?.estado).toBe('falha');
      expect(schema?.detalhe).toContain('faltam 15 tabelas');
      // A ação nomeia os quatro arquivos, na ordem.
      expect(schema?.acao).toContain('01-multi-tenancy.sql');
      expect(schema?.acao).toContain('04-ingestao.sql');
    });

    /**
     * Antes desta guarda, o doctor estourava com `relation "plans" does not
     * exist` e escondia o diagnóstico real, que é o schema faltando.
     */
    it('não estoura nas checagens que dependem das tabelas', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      const dependentes = checagem(resultado, 'carga inicial e escritório');
      expect(dependentes?.estado).toBe('aviso');
      expect(dependentes?.detalhe).toMatch(/depende do schema/);
      expect(resultado.ok).toBe(false);
    });

    it('acusa a ausência do trigger append-only', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      const trigger = checagem(resultado, 'event log append-only');
      expect(trigger?.estado).toBe('falha');
      expect(trigger?.detalhe).toMatch(/UPDATE e DELETE em events não estão bloqueados/);
    });
  });

  describe('banco com schema aplicado', () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: urlVazia, max: 1 });
      await applyMigrations(pool);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('reconhece schema, funções e trigger', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      expect(checagem(resultado, 'schema')?.estado).toBe('ok');
      expect(checagem(resultado, 'funções')?.estado).toBe('ok');
      expect(checagem(resultado, 'event log append-only')?.estado).toBe('ok');
    });

    it('reconhece a carga inicial de cobrança semeada pela migration', async () => {
      const carga = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'carga inicial de cobrança',
      );

      expect(carga?.estado).toBe('ok');
      expect(carga?.detalhe).toContain('5 planos');
    });

    /**
     * É o caso que aconteceu de verdade: as tabelas chegaram e os INSERT de
     * carga não. A calculadora de preço pública passa a devolver lista vazia sem
     * erro, e a fatura só falha no fechamento do mês.
     */
    it('acusa carga inicial ausente com schema presente', async () => {
      await pool.query('delete from plans');
      await pool.query('delete from billing_settings');

      try {
        const carga = checagem(
          await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
          'carga inicial de cobrança',
        );

        expect(carga?.estado).toBe('falha');
        expect(carga?.detalhe).toContain('0 planos (esperado 5)');
        expect(carga?.acao).toContain('03-cobranca.sql');
      } finally {
        await applyMigrations(pool);
      }
    });

    it('acusa a falta de escritório, que faria a API responder 403 em tudo', async () => {
      const escritorio = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'escritório e usuário',
      );

      expect(escritorio?.estado).toBe('falha');
      expect(escritorio?.acao).toContain('05-bootstrap-escritorio.sql');
      expect(escritorio?.acao).toMatch(/Auto Confirm User/);
    });

    it('dá tudo ok quando o escritório existe com um owner', async () => {
      const tenant = '33333333-3333-3333-3333-333333333333';
      await pool.query(`insert into tenants (id, name) values ($1, 'Escritório') 
                        on conflict do nothing`, [tenant]);
      await pool.query(
        `insert into memberships (tenant_id, user_id, role)
         values ($1::uuid, '44444444-4444-4444-4444-444444444444', 'owner')
         on conflict do nothing`,
        [tenant],
      );

      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      expect(resultado.ok).toBe(true);
      expect(resultado.checagens.every((c) => c.estado === 'ok')).toBe(true);
      expect(resultado.checagens.every((c) => c.acao === undefined)).toBe(true);
    });
  });
});
