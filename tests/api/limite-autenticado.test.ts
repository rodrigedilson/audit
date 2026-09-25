import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createMembership, createTenant } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

/** O mesmo teto da janela de um minuto declarada no servidor. */
const POR_MINUTO = 240;

/**
 * Limite das rotas autenticadas.
 *
 * As públicas já tinham limite; estas não tinham nenhum. Com token válido dava
 * para varrer a API no ritmo da rede, e cada chamada resolve escritório e
 * consulta o banco — o custo do abuso caía inteiro sobre o Postgres.
 */
describe.skipIf(!DATABASE_URL)('API — limite das rotas autenticadas', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let usuario: string;
  let outro: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const chamar = async (userId: string): Promise<import('light-my-request').Response> =>
    app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await tokenFor(userId)}` },
    });

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
    tenantId = await createTenant(pool, 'Escritório do limite');
    usuario = await createMembership(pool, tenantId, 'owner');
    outro = await createMembership(pool, tenantId, 'owner');
  });

  it('recusa com 429 e diz quanto esperar depois de estourar a janela', async () => {
    for (let i = 0; i < POR_MINUTO; i++) {
      const r = await chamar(usuario);
      // Falha no primeiro desvio, e não no fim: se o teto mudar, a mensagem
      // aponta em qual chamada quebrou em vez de só dizer "esperava 429".
      expect(r.statusCode, `chamada ${i + 1} deveria passar`).toBe(200);
    }

    const excedente = await chamar(usuario);

    expect(excedente.statusCode).toBe(429);
    expect(Number(excedente.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.stringify(excedente.json())).toMatch(/Muitas requisições/);
  });

  /**
   * A chave é o usuário, e não o IP nem o escritório. Um contador que abusa não
   * pode derrubar o escritório inteiro — e o IP de um escritório é compartilhado
   * entre os contadores dele, então limitar por IP puniria o escritório grande.
   */
  it('não atinge outro usuário do mesmo escritório', async () => {
    for (let i = 0; i <= POR_MINUTO; i++) {
      await chamar(usuario);
    }

    expect((await chamar(usuario)).statusCode).toBe(429);
    expect((await chamar(outro)).statusCode).toBe(200);
  });

  /**
   * `/v1/health` fica fora da autenticação, e portanto fora deste limite. É o
   * que o Render consulta para saber se a instância está de pé: limitá-la
   * derrubaria o serviço por excesso de zelo.
   */
  it('não limita o health check', async () => {
    for (let i = 0; i <= POR_MINUTO; i++) {
      await chamar(usuario);
    }

    const saude = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(saude.statusCode).toBe(200);
  });
});
