import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];

/**
 * Limites das rotas públicas. Servidor próprio: o limitador é por instância, e
 * dividir o servidor com outros testes somaria as chamadas deles às daqui.
 */
describe.skipIf(!DATABASE_URL)('API — limites das rotas públicas', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const env = loadEnv({
      AUDIT_ENV: 'dev',
      DATABASE_URL,
      // Porta 9 recusa conexão na hora: o login falha rápido sem ir à rede, e o
      // que se testa é o limite, que vem antes da ida ao Supabase.
      SUPABASE_URL: 'http://127.0.0.1:9',
      SUPABASE_ANON_KEY: 'chave-anon-de-teste',
      SUPABASE_JWT_SECRET: 'segredo-de-teste-que-nao-vai-para-producao',
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

  /** A rota repassa a senha ao Supabase: sem limite, servia de oráculo de senha. */
  it('o sexto login seguido do mesmo e-mail recebe 429', async () => {
    const tentar = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'alvo@teste.com', password: 'errada' },
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await tentar()).statusCode).not.toBe(429);
    }
    const barrada = await tentar();

    expect(barrada.statusCode).toBe(429);
    expect(barrada.json().code).toBe('rate_limited');
    expect(barrada.headers['retry-after']).toBeDefined();
  });

  it('a calculadora pública barra o 31º cálculo no minuto', async () => {
    const calcular = () =>
      app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: { clients: [{ regime: 'simples_hibrido', quantity: 10 }] },
      });

    for (let i = 0; i < 30; i += 1) {
      expect((await calcular()).statusCode).toBe(200);
    }
    expect((await calcular()).statusCode).toBe(429);
  });
});
