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

describe.skipIf(!DATABASE_URL)('API — séries de índice e correção monetária', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let owner: string;

  const call = async (url: string, userId?: string) => {
    const headers: Record<string, string> = {};
    if (userId !== undefined) {
      headers['authorization'] = `Bearer ${await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode(JWT_SECRET))}`;
    }
    return app.inject({ method: 'GET', url, headers });
  };

  /** Carrega 1% ao mês, para a conta fechar à mão. */
  const carregarPontos = async (periods: readonly string[]): Promise<void> => {
    for (const period of periods) {
      await pool.query(
        `insert into financial_index_points (index_id, period, variation, source_ref)
         values ('ipca', $1::char(7), 0.01, 'conferido no teste')
         on conflict (index_id, period) do update set variation = excluded.variation`,
        [period],
      );
    }
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
    const tenantId = await createTenant(pool, 'Escritório dos Índices');
    owner = await createMembership(pool, tenantId, 'owner');

    /**
     * As séries são GLOBAIS — não têm `tenant_id`, porque um índice não
     * pertence a um escritório. O isolamento por tenant que o resto da suíte usa
     * não vale aqui, então cada teste devolve a tabela ao estado de nascimento.
     */
    await pool.query('delete from financial_index_points');
    await pool.query(
      `update financial_indices set verified = false, source_ref = null, verified_at = null`,
    );
  });

  describe('catálogo', () => {
    it('lista as séries e diz quantas têm dado carregado', async () => {
      const r = await call('/v1/financial-indices', owner);
      const corpo = r.json();

      expect(r.statusCode).toBe(200);
      expect(corpo.indices.map((i: { index_id: string }) => i.index_id)).toContain('ipca');
      // Nascem vazias: catálogo sem ponto não corrige nada.
      expect(corpo.loaded_count).toBe(0);
      expect(corpo.verified_count).toBe(0);
    });

    it('a cobertura aparece depois de carregar pontos', async () => {
      await carregarPontos(['2027-02', '2027-03']);

      const corpo = (await call('/v1/financial-indices', owner)).json();
      const ipca = corpo.indices.find((i: { index_id: string }) => i.index_id === 'ipca');

      expect(ipca.point_count).toBe(2);
      expect(ipca.first_period).toBe('2027-02');
      expect(ipca.last_period).toBe('2027-03');
      expect(corpo.loaded_count).toBe(1);
    });

    it('não responde sem token — a série é do módulo de perícia, não do público', async () => {
      expect((await call('/v1/financial-indices')).statusCode).toBe(401);
    });
  });

  describe('fator acumulado', () => {
    it('acumula de from exclusivo até to inclusivo', async () => {
      await carregarPontos(['2027-02', '2027-03']);

      const corpo = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-03', owner)
      ).json();

      expect(corpo.months).toBe(2);
      expect(corpo.factor).toBeCloseTo(1.0201, 8);
      expect(corpo.source).toBe('IBGE');
    });

    /**
     * Série sem cobertura não é erro do chamador: é dado que falta carregar.
     * Devolver 4xx faria a tela tratar como falha o que é estado normal.
     */
    it('intervalo descoberto devolve 200 com o motivo, e fator nulo', async () => {
      await carregarPontos(['2027-02']);

      const r = await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-04', owner);

      expect(r.statusCode).toBe(200);
      expect(r.json().factor).toBeNull();
      expect(r.json().unavailable_reason).toContain('2027-03');
    });

    it('série vazia também devolve 200 com o motivo', async () => {
      const r = await call('/v1/financial-indices/igpm/factor?from=2027-01&to=2027-03', owner);

      expect(r.statusCode).toBe(200);
      expect(r.json().factor).toBeNull();
    });

    /** Índice fora do catálogo é erro de quem chamou, e aí sim é 4xx. */
    it('índice inexistente é rejeitado', async () => {
      const r = await call('/v1/financial-indices/nao-existe/factor?from=2027-01&to=2027-03', owner);

      expect(r.statusCode).toBe(422);
    });

    it('competência malformada é barrada pelo schema', async () => {
      const r = await call('/v1/financial-indices/ipca/factor?from=2027-13&to=2027-03', owner);

      expect(r.statusCode).toBe(400);
    });

    it('a série declara se foi conferida, para o laudo poder ressalvar', async () => {
      await carregarPontos(['2027-02']);
      const antes = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-02', owner)
      ).json();
      expect(antes.verified).toBe(false);

      await pool.query(
        `update financial_indices set verified = true, source_ref = 'https://ibge…',
                verified_at = now() where index_id = 'ipca'`,
      );
      const depois = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-02', owner)
      ).json();

      expect(depois.verified).toBe(true);
    });
  });

  describe('correção de um principal', () => {
    it('corrige e devolve a memória de cálculo junto', async () => {
      await carregarPontos(['2027-02', '2027-03']);

      const corpo = (
        await call(
          '/v1/financial-indices/ipca/factor?from=2027-01&to=2027-03&principal_cents=100000',
          owner,
        )
      ).json();

      // 100.000 × 1,0201 = 102.010
      expect(corpo.restated_cents).toBe(102_010);
      expect(corpo.correction_cents).toBe(2_010);
      expect(corpo.steps.length).toBeGreaterThan(0);
    });

    it('sem principal informado devolve só o fator, sem memória', async () => {
      await carregarPontos(['2027-02']);

      const corpo = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-02', owner)
      ).json();

      expect(corpo.restated_cents).toBeUndefined();
      expect(corpo.steps).toBeUndefined();
    });

    it('intervalo descoberto não corrige, e diz por quê', async () => {
      const corpo = (
        await call(
          '/v1/financial-indices/ipca/factor?from=2027-01&to=2027-06&principal_cents=100000',
          owner,
        )
      ).json();

      expect(corpo.restated_cents).toBeNull();
      expect(String(corpo.unavailable_reason).length).toBeGreaterThan(0);
    });
  });
});
