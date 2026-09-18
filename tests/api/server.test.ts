import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { PostgresEventStoreRepository } from '../../src/infrastructure/persistence/postgres-event-store.repository.js';
import { EventAppenderService } from '../../src/esaa/core/event-store/event-appender.service.js';
import { EventScope } from '../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];

const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

/** Usuário autenticado que não pertence a escritório nenhum. */
const USER_ORPHAN = randomUUID();

describe.skipIf(!DATABASE_URL)('API HTTP', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  // Recriados por teste, para que arquivos em paralelo não disputem fixtures.
  let TENANT_A: string;
  let TENANT_B: string;
  let USER_A: string;
  let USER_B: string;
  let CNPJ_A: string;
  let CNPJ_B: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({ email: `${userId}@exemplo.com.br` })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const authGet = async (url: string, userId: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await tokenFor(userId)}` } });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    const env = loadEnv({
      DATABASE_URL,
      SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
      SUPABASE_ANON_KEY: 'chave-anon-de-teste',
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_JWT_AUDIENCE: AUDIENCE,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);

    app = await buildServer({ env, pool });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /**
   * Dois escritórios novos por teste. Sem `truncate`: ele apagaria as fixtures
   * dos outros arquivos de teste que o vitest roda em paralelo. Como toda
   * consulta da API é escopada por tenant, o resíduo dos testes anteriores é
   * invisível — e é exatamente essa propriedade que os testes de isolamento
   * abaixo verificam.
   */
  beforeEach(async () => {
    TENANT_A = await createTenant(pool, 'Escritório A');
    TENANT_B = await createTenant(pool, 'Escritório B');
    USER_A = await createMembership(pool, TENANT_A, 'owner');
    USER_B = await createMembership(pool, TENANT_B, 'accountant');
    CNPJ_A = randomCnpj();
    CNPJ_B = randomCnpj();

    await createClient(pool, TENANT_A, CNPJ_A, { legalName: 'Cliente do A' });
    await createClient(pool, TENANT_B, CNPJ_B, {
      legalName: 'Cliente do B',
      regime: 'lucro_presumido',
    });
  });

  describe('autenticação', () => {
    it('health é público', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('recusa requisição sem token', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/clients' });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('unauthorized');
    });

    it('recusa token com assinatura de outro segredo', async () => {
      const forjado = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(USER_A)
        .setAudience(AUDIENCE)
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode('outro-segredo'));

      const response = await app.inject({
        method: 'GET',
        url: '/v1/clients',
        headers: { authorization: `Bearer ${forjado}` },
      });

      expect(response.statusCode).toBe(401);
    });

    it('recusa token expirado', async () => {
      const expirado = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(USER_A)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(new TextEncoder().encode(JWT_SECRET));

      const response = await app.inject({
        method: 'GET',
        url: '/v1/clients',
        headers: { authorization: `Bearer ${expirado}` },
      });

      expect(response.statusCode).toBe(401);
    });

    it('recusa Authorization mal formado', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/clients',
        headers: { authorization: 'Token abc' },
      });
      expect(response.statusCode).toBe(401);
    });

    /**
     * Token válido não basta: sem associação não há escritório, e sem escritório
     * não há o que ler. É o caso de um usuário removido cujo token ainda vale.
     */
    it('recusa usuário autenticado sem associação a escritório', async () => {
      const response = await authGet('/v1/clients', USER_ORPHAN);
      expect(response.statusCode).toBe(403);
      expect(response.json().message).toMatch(/não pertence a nenhum escritório/i);
    });

    it('GET /me devolve usuário, papel e escritório resolvidos do banco', async () => {
      const response = await authGet('/v1/me', USER_A);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        user: { id: USER_A, role: 'owner' },
        tenant: { id: TENANT_A, name: 'Escritório A' },
      });
    });

    it('o papel vem da associação, não do token', async () => {
      expect((await authGet('/v1/me', USER_B)).json().tenant.id).toBe(TENANT_B);
      expect((await authGet('/v1/me', USER_B)).json().user.role).toBe('accountant');
    });
  });

  describe('isolamento entre escritórios', () => {
    it('cada carteira mostra somente os próprios CNPJs', async () => {
      const respostaA = await authGet('/v1/clients', USER_A);
      const respostaB = await authGet('/v1/clients', USER_B);

      expect(respostaA.json().items.map((c: { cnpj: string }) => c.cnpj)).toEqual([CNPJ_A]);
      expect(respostaB.json().items.map((c: { cnpj: string }) => c.cnpj)).toEqual([CNPJ_B]);
      expect(respostaA.json().total).toBe(1);
    });

    /**
     * 404 e não 403 de propósito: um 403 confirmaria que aquele CNPJ está
     * cadastrado na plataforma, e a carteira de um escritório é informação
     * comercial sensível diante de um concorrente.
     */
    it('responde 404 para CNPJ que existe em outro escritório, sem confirmar existência', async () => {
      const response = await authGet(`/v1/clients/${CNPJ_B}`, USER_A);

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('not_found');
    });

    it('responde 404 igual para CNPJ inexistente em qualquer lugar', async () => {
      const inexistente = await authGet(`/v1/clients/${randomCnpj()}`, USER_A);
      const deOutro = await authGet(`/v1/clients/${CNPJ_B}`, USER_A);

      // As duas respostas têm de ser indistinguíveis, senão a diferença de
      // status ou de mensagem já é o vazamento.
      expect(inexistente.statusCode).toBe(deOutro.statusCode);
      expect(inexistente.json().code).toBe(deOutro.json().code);
    });

    it('não vaza eventos de outro escritório', async () => {
      const scopeB = EventScope.create(TENANT_B, CNPJ_B);
      const appender = new EventAppenderService(
        new PostgresEventStoreRepository(pool, scopeB),
        scopeB,
      );
      await appender.append({
        action: 'run.start',
        taskId: 'run-b',
        actor: 'tech-lead',
        payload: { run_id: 'run-b', phase_name: 'B', objectives: [] },
      });

      // O CNPJ do B nem é visível para o A.
      expect((await authGet(`/v1/clients/${CNPJ_B}/events`, USER_A)).statusCode).toBe(404);
      // E o B vê o próprio.
      expect((await authGet(`/v1/clients/${CNPJ_B}/events`, USER_B)).json()).toHaveLength(1);
    });
  });

  describe('carteira', () => {
    it('detalha o cliente e indica ausência de certificado', async () => {
      const response = await authGet(`/v1/clients/${CNPJ_A}`, USER_A);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        cnpj: CNPJ_A,
        legal_name: 'Cliente do A',
        regime: 'simples_hibrido',
        status: 'active',
        has_certificate: false,
      });
    });

    it('rejeita CNPJ com máscara na rota', async () => {
      const response = await authGet('/v1/clients/12.345.678%2F0001-95', USER_A);
      expect(response.statusCode).toBe(400);
    });

    it('lista competências do cliente, mais recente primeiro', async () => {
      await pool.query(
        `insert into periods (tenant_id, cnpj, period, state) values
           ($1, $2, '2027-01', 'open'), ($1, $2, '2027-02', 'assessed')`,
        [TENANT_A, CNPJ_A],
      );

      const response = await authGet(`/v1/clients/${CNPJ_A}/periods`, USER_A);

      expect(response.json().map((p: { period: string }) => p.period)).toEqual(['2027-02', '2027-01']);
    });
  });

  describe('event log e verificação', () => {
    const seed = async (): Promise<void> => {
      const scope = EventScope.create(TENANT_A, CNPJ_A);
      const appender = new EventAppenderService(
        new PostgresEventStoreRepository(pool, scope),
        scope,
      );
      await appender.append({
        action: 'run.start',
        taskId: 'run-001',
        actor: 'tech-lead',
        payload: { run_id: 'run-001', phase_name: 'Fechamento', objectives: [] },
      });
      await appender.append({
        action: 'task.create',
        taskId: 'T-1',
        actor: 'tech-lead',
        payload: {
          kind: 'impl',
          description: 'Apurar',
          assigned_agent: 'coder',
          parent_run: 'run-001',
        },
        period: '2027-01',
      });
    };

    it('lista eventos em ordem, com event_seq numérico', async () => {
      await seed();
      const response = await authGet(`/v1/clients/${CNPJ_A}/events`, USER_A);
      const events = response.json();

      expect(events).toHaveLength(2);
      expect(events.map((e: { event_seq: number }) => e.event_seq)).toEqual([0, 1]);
      expect(events[1].period).toBe('2027-01');
    });

    it('pagina por after_seq e filtra por action', async () => {
      await seed();

      expect((await authGet(`/v1/clients/${CNPJ_A}/events?after_seq=0`, USER_A)).json()).toHaveLength(1);
      expect(
        (await authGet(`/v1/clients/${CNPJ_A}/events?action=run.start`, USER_A)).json(),
      ).toHaveLength(1);
    });

    it('POST /verify confirma que a projeção fecha com o log', async () => {
      await seed();
      const token = await tokenFor(USER_A);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/clients/${CNPJ_A}/verify`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.stored_hash).toBe(body.replayed_hash);
      expect(body.last_event_seq).toBe(1);
    });

    it('POST /verify de log vazio também fecha (determinismo do log vazio)', async () => {
      const token = await tokenFor(USER_A);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/clients/${CNPJ_A}/verify`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.json().ok).toBe(true);
      expect(response.json().last_event_seq).toBe(-1);
    });
  });

  it('rota inexistente responde 404 no formato Error do contrato', async () => {
    const response = await authGet('/v1/nao-existe', USER_A);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });
});
