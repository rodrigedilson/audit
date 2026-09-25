import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { FEATURE_POR_ROTA, FEATURE_POR_ROTA_DA_CARTEIRA } from '../../src/api/plugins/plan-gate.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

/** Uma leitura por feature que o plano do MEI não inclui. */
const FECHADAS_PARA_O_MEI: readonly [string, string][] = [
  ['apuracao_dual', 'assessments/2026-01'],
  ['apuracao_dual', 'assessments/2026-01/trace'],
  ['contra_apuracao', 'fisco-assessments/2026-01'],
  ['credito_em_risco', 'credits/at-risk'],
  ['dossie_saldo_credor', 'credit-dossier/2026-01'],
  ['sped_completo', 'icms-ipi-reconciliation/2026-01'],
  ['capag', 'capag'],
];

describe.skipIf(!DATABASE_URL)('API — o que o plano do CNPJ inclui', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let mei: string;
  let real: string;

  const token = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const get = async (url: string, userId = owner) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await token(userId)}` } });

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
    tenantId = await createTenant(pool, 'Escritório dos Planos');
    owner = await createMembership(pool, tenantId, 'owner');
    mei = randomCnpj();
    real = randomCnpj();
    await createClient(pool, tenantId, mei, { regime: 'mei' });
    await createClient(pool, tenantId, real, { regime: 'lucro_real' });
  });

  describe.each(FECHADAS_PARA_O_MEI)('%s — GET %s', (feature, caminho) => {
    it('403 feature_not_in_plan no CNPJ cujo plano não inclui, com os planos que incluem', async () => {
      const r = await get(`/v1/clients/${mei}/${caminho}`);

      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: 'feature_not_in_plan', feature, regime: 'mei' });
      expect(r.json().plans_with_feature).toContain('lucro_real');
      expect(r.json().plans_with_feature).not.toContain('mei');
    });

    it('passa no CNPJ cujo plano inclui', async () => {
      expect((await get(`/v1/clients/${real}/${caminho}`)).statusCode).not.toBe(403);
    });
  });

  it('o que todo plano inclui passa no MEI: saúde do cadastro, coleta e simulador', async () => {
    for (const caminho of ['items', 'items/health', 'dfe', 'simulations']) {
      expect((await get(`/v1/clients/${mei}/${caminho}`)).statusCode, caminho).not.toBe(403);
    }
  });

  it('a base de todo plano não é fechada: documentos, competências, eventos', async () => {
    for (const caminho of ['documents', 'periods', 'events']) {
      expect((await get(`/v1/clients/${mei}/${caminho}`)).statusCode, caminho).not.toBe(403);
    }
  });

  /** 403 confirmaria que o CNPJ existe noutro escritório (ver TenantResolver.scopeFor). */
  it('CNPJ de outro escritório continua 404, e não 403', async () => {
    const outro = await createTenant(pool, 'Outro Escritório');
    const alheio = randomCnpj();
    await createClient(pool, outro, alheio, { regime: 'mei' });

    expect((await get(`/v1/clients/${alheio}/assessments/2026-01`)).statusCode).toBe(404);
  });

  describe('calendário da carteira', () => {
    it('aberto quando algum CNPJ da carteira tem o calendário', async () => {
      expect((await get('/v1/deadlines')).statusCode).toBe(200);
    });

    it('403 quando nenhum CNPJ da carteira tem', async () => {
      const sozinho = await createTenant(pool, 'Escritório de MEI');
      const dono = await createMembership(pool, sozinho, 'owner');
      await createClient(pool, sozinho, randomCnpj(), { regime: 'mei' });

      const r = await get('/v1/deadlines', dono);
      expect(r.statusCode).toBe(403);
      expect(r.json().feature).toBe('calendario');
    });
  });

  /** O mapa é o inventário do que é vendido: rota que saiu do servidor não pode ficar nele. */
  it('toda rota do mapa existe no servidor', () => {
    const rotas = [...Object.keys(FEATURE_POR_ROTA), ...Object.keys(FEATURE_POR_ROTA_DA_CARTEIRA)];
    const inexistentes = rotas.filter(
      (url) => !(['GET', 'POST', 'PUT'] as const).some((method) => app.hasRoute({ method, url: `/v1${url}` })),
    );
    expect(inexistentes).toEqual([]);
  });

  it('toda feature do mapa existe em algum plano', async () => {
    const { rows } = await pool.query<{ features: string[] }>('select features from plans');
    const vendidas = new Set(rows.flatMap((r) => r.features));
    const features = new Set([...Object.values(FEATURE_POR_ROTA), ...Object.values(FEATURE_POR_ROTA_DA_CARTEIRA)]);
    expect([...features].filter((f) => !vendidas.has(f))).toEqual([]);
  });
});
