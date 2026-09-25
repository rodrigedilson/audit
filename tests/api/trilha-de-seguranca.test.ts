import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

/**
 * A gravação é disparada sem esperar — ela não pode atrasar a resposta. O teste
 * espera o banco assentar antes de conferir.
 */
const assentar = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 120));
};

describe.skipIf(!DATABASE_URL)('API — trilha de segurança', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let viewer: string;
  let cnpj: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  /**
   * `security_events` é global: os outros arquivos de teste rodam em paralelo e
   * escrevem nela também. Sem uma marca por requisição, a consulta pegava as
   * linhas deles — foi o que aconteceu, e o teste passava sozinho e falhava na
   * suíte. Cada chamada leva um user-agent único, e a consulta filtra por ele.
   */
  const marca = (nome: string): string => `teste-trilha-${nome}-${process.pid}`;

  const eventos = async (
    kind: string,
    userAgent: string,
  ): Promise<Record<string, unknown>[]> => {
    const { rows } = await pool.query<Record<string, unknown>>(
      `select * from security_events
        where kind = $1 and user_agent = $2 order by id desc limit 5`,
      [kind, userAgent],
    );
    return rows;
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const env = loadEnv({
      AUDIT_ENV: 'dev',
      DATABASE_URL,
      SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
      SUPABASE_ANON_KEY: 'chave-anon-de-teste',
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_JWT_AUDIENCE: AUDIENCE,
      CERTIFICATE_MASTER_KEY: 'chave-mestra-de-teste-com-mais-de-32-caracteres',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    app = await buildServer({ env, pool });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    tenantId = await createTenant(pool, 'Escritório da trilha');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
  });

  /**
   * O token inválido é o evento mais comum de um ataque e o que hoje só existia
   * na saída padrão, que o provedor guarda por pouco tempo.
   */
  it('registra token inválido como nao_autenticado', async () => {
    const agente = marca('401');
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer token-que-nao-vale', 'user-agent': agente },
    });
    await assentar();

    expect(r.statusCode).toBe(401);
    const [evento] = await eventos('nao_autenticado', agente);
    expect(evento?.['route']).toBe('/v1/me');
    expect(evento?.['method']).toBe('GET');
    expect(evento?.['ip_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  /** Recusa por papel: diz quem foi, porque aqui o usuário já é conhecido. */
  it('registra recusa por papel com o usuário e o escritório', async () => {
    const agente = marca('403');
    const r = await app.inject({
      method: 'POST',
      url: '/v1/clients',
      headers: { authorization: `Bearer ${await tokenFor(viewer)}`, 'user-agent': agente },
      payload: { cnpj: randomCnpj(), legal_name: 'Teste LTDA', regime: 'lucro_real' },
    });
    await assentar();

    expect(r.statusCode).toBe(403);
    const [evento] = await eventos('sem_permissao', agente);
    expect(evento?.['user_id']).toBe(viewer);
    expect(evento?.['tenant_id']).toBe(tenantId);
  });

  /**
   * Recusa por plano é decisão comercial, não sinal de segurança. Registrá-la
   * encheria a trilha de ruído previsível e afogaria o que importa.
   */
  it('não registra recusa por plano como evento de segurança', async () => {
    const agente = marca('plano');
    await app.inject({
      method: 'GET',
      url: `/v1/clients/${cnpj}/events`,
      headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'user-agent': agente },
    });
    await assentar();

    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from security_events where user_agent = $1',
      [agente],
    );
    expect(rows[0]!.n).toBe('0');
  });

  /**
   * O id é o que liga a trilha ao log. Sem ele, a linha da trilha dizia "403 em
   * /v1/clients" e não havia como achar a linha de log correspondente.
   */
  it('devolve x-request-id e grava o mesmo id na trilha', async () => {
    const agente = marca('reqid');
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer token-que-nao-vale', 'user-agent': agente },
    });
    await assentar();

    const id = r.headers['x-request-id'];
    expect(id).toBeTruthy();

    const [evento] = await eventos('nao_autenticado', agente);
    expect(evento?.['request_id']).toBe(id);
  });

  /** Quando o proxy manda o dele, o dele vence: é com ele que se correlaciona. */
  it('respeita o x-request-id do proxy', async () => {
    const agente = marca('proxy');
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        authorization: 'Bearer token-que-nao-vale',
        'user-agent': agente,
        'x-request-id': 'do-proxy-42',
      },
    });
    await assentar();

    expect(r.headers['x-request-id']).toBe('do-proxy-42');
    expect((await eventos('nao_autenticado', agente))[0]?.['request_id']).toBe('do-proxy-42');
  });

  /**
   * Cabeçalho é campo livre e acaba dentro do log. Uma quebra de linha nele
   * escreveria uma linha falsa — e log adulterável não serve de evidência.
   */
  it('higieniza o id vindo de fora', async () => {
    const agente = marca('injecao');
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        authorization: 'Bearer token-que-nao-vale',
        'user-agent': agente,
        'x-request-id': 'bom\n2026-01-01 FALSO login_ok',
      },
    });

    const id = String(r.headers['x-request-id']);
    expect(id).not.toContain('\n');
    expect(id).not.toContain(' ');
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /** A trilha não pode atrasar nem derrubar a resposta que ela observa. */
  it('a resposta sai normalmente com a trilha ligada', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await tokenFor(owner)}` },
    });

    expect(r.statusCode).toBe(200);
  });
});
