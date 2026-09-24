import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const WEBHOOK_TOKEN = 'token-do-webhook-de-teste';
const AUDIENCE = 'authenticated';

describe.skipIf(!DATABASE_URL)('API — planos e cobrança', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let accountant: string;
  let cnpj: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    userId: string,
    payload?: Record<string, unknown>,
  ): Promise<import('light-my-request').Response> => {
    const options: import('light-my-request').InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${await tokenFor(userId)}` },
    };
    if (payload !== undefined) {
      options.payload = payload;
    }
    return app.inject(options);
  };

  /** Abre competência direto na tabela: aqui o alvo é a cobrança, não o pipeline. */
  const openPeriod = async (targetCnpj: string, period: string): Promise<void> => {
    await pool.query(
      `insert into periods (tenant_id, cnpj, period, state) values ($1::uuid, $2::char(14), $3, 'open')
       on conflict do nothing`,
      [tenantId, targetCnpj, period],
    );
  };

  const currentMonth = (): string => new Date().toISOString().slice(0, 7);

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
      ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
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
    tenantId = await createTenant(pool, 'Escritório de Cobrança');
    owner = await createMembership(pool, tenantId, 'owner');
    accountant = await createMembership(pool, tenantId, 'accountant');
    cnpj = randomCnpj();
  });

  describe('catálogo público', () => {
    /** Preço público antes de qualquer contato comercial — ver briefing. */
    it('GET /plans dispensa autenticação', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/plans' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.minimum_cents).toBe(15_000);
      expect(body.plans).toHaveLength(5);
      expect(body.plans.find((p: { regime: string }) => p.regime === 'simples_hibrido')).toMatchObject({
        monthly_cents: 2900,
      });
    });

    it('a calculadora de preço também é pública', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: { clients: [{ regime: 'simples_hibrido', quantity: 10 }] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().total_cents).toBe(29_000);
    });

    it('a calculadora mostra o ajuste de mínimo separado do subtotal', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: { clients: [{ regime: 'mei', quantity: 5 }] },
      });

      expect(response.json()).toMatchObject({
        subtotal_cents: 4_500,
        minimum_adjustment_cents: 10_500,
        total_cents: 15_000,
      });
    });

    it('a calculadora recusa regime inexistente', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: { clients: [{ regime: 'lucro_arbitrado', quantity: 1 }] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('a calculadora limita a quantidade, para não servir de gerador de carga', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: { clients: [{ regime: 'mei', quantity: 999_999 }] },
      });

      expect(response.statusCode).toBe(400);
    });

    /**
     * A escada de volume é pública pelo mesmo motivo que o preço: esconder o
     * desconto atrás de "fale com um consultor" é a opacidade que o produto
     * combate.
     */
    it('GET /plans publica a escada de faixas e o teto', async () => {
      const body = (await app.inject({ method: 'GET', url: '/v1/plans' })).json();

      expect(body.tiers).toHaveLength(5);
      expect(body.tiers[0]).toMatchObject({ from_clients: 1, discount_bps: 0 });
      expect(body.tiers[4]).toMatchObject({ from_clients: 1001, discount_bps: 5000 });
      /**
       * Teto global de R$ 25.000. O critério está na migration: não morder dentro
       * do ICP (até 300 CNPJs) em nenhum regime — o pior caso é Lucro Real, que a
       * 300 CNPJs paga R$ 24.030.
       */
      expect(body.cap_cents).toBe(2_500_000);
    });

    it('carteira pequena não muda de preço com a escada ligada', async () => {
      const body = (
        await app.inject({
          method: 'POST',
          url: '/v1/price-calculator',
          payload: { clients: [{ regime: 'simples_hibrido', quantity: 10 }] },
        })
      ).json();

      expect(body.volume_discount_cents).toBe(0);
      expect(body.total_cents).toBe(29_000);
    });

    /**
     * O caso que motivou a degressão: a carteira de 1.200 CNPJs que o modelo
     * linear cobraria R$ 34.800/mês. Antes das faixas esta chamada nem passava
     * pelo schema, que limitava a quantidade a 2.000 por ser O(quantidade).
     */
    it('a calculadora cobre a carteira de 1.200 CNPJs e explica a escada', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: { clients: [{ regime: 'simples_hibrido', quantity: 1200 }] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.subtotal_cents).toBe(3_480_000);
      expect(body.volume_discount_cents).toBe(1_102_000);
      expect(body.total_cents).toBe(2_378_000);

      // As quatro parcelas fecham por soma — é o que a tela mostra.
      expect(
        body.subtotal_cents -
          body.volume_discount_cents +
          body.cap_adjustment_cents +
          body.minimum_adjustment_cents,
      ).toBe(body.total_cents);

      const linha = body.lines[0];
      expect(linha.tiers).toHaveLength(5);
      expect(linha.tiers[0]).toMatchObject({ from_clients: 1, quantity: 100, discount_bps: 0 });
    });

    it('a calculadora recusa a soma que estoura o teto de simulação', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/price-calculator',
        payload: {
          clients: [
            { regime: 'mei', quantity: 10_000 },
            { regime: 'lucro_real', quantity: 10_000 },
            { regime: 'simples_hibrido', quantity: 10_000 },
          ],
        },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('definição de CNPJ ativo', () => {
    /**
     * A regra de faturamento: ativo **e** com competência no mês. Cadastrar e
     * não trabalhar não cobra.
     */
    it('CNPJ cadastrado sem competência no mês não é faturado', async () => {
      await createClient(pool, tenantId, cnpj);

      const response = await call('GET', '/v1/subscription', owner);

      expect(response.json().billable_clients).toBe(0);
      expect(response.json().total_cents).toBe(0);
    });

    it('CNPJ com competência no mês é faturado pelo preço do regime', async () => {
      await createClient(pool, tenantId, cnpj, { regime: 'lucro_presumido' });
      await openPeriod(cnpj, currentMonth());

      const response = await call('GET', '/v1/subscription', owner);

      expect(response.json().billable_clients).toBe(1);
      // R$ 49 fica abaixo do piso de R$ 150, então a fatura vai ao mínimo.
      expect(response.json()).toMatchObject({
        subtotal_cents: 4_900,
        minimum_adjustment_cents: 10_100,
        total_cents: 15_000,
      });
    });

    it('CNPJ inativo não é faturado, mesmo com competência aberta', async () => {
      await createClient(pool, tenantId, cnpj);
      await openPeriod(cnpj, currentMonth());
      await pool.query(
        `update clients set status = 'inactive' where tenant_id = $1::uuid and cnpj = $2`,
        [tenantId, cnpj],
      );

      expect((await call('GET', '/v1/subscription', owner)).json().billable_clients).toBe(0);
    });

    it('competência de outro mês não conta para a fatura do mês corrente', async () => {
      await createClient(pool, tenantId, cnpj);
      await openPeriod(cnpj, '2020-01');

      expect((await call('GET', '/v1/subscription', owner)).json().billable_clients).toBe(0);
    });

    it('conta um CNPJ por regime, somando a carteira', async () => {
      const outro = randomCnpj();
      await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
      await createClient(pool, tenantId, outro, { regime: 'lucro_real' });
      await openPeriod(cnpj, currentMonth());
      await openPeriod(outro, currentMonth());

      const response = await call('GET', '/v1/subscription', owner);

      expect(response.json().billable_clients).toBe(2);
      expect(response.json().subtotal_cents).toBe(17_800);
      expect(response.json().total_cents).toBe(17_800);
    });
  });

  describe('assinatura e trial', () => {
    it('a primeira consulta abre o trial automaticamente', async () => {
      const response = await call('GET', '/v1/subscription', owner);

      expect(response.json().status).toBe('trialing');
      expect(response.json().trial_ends_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('o trial dura os 30 dias do briefing', async () => {
      const response = await call('GET', '/v1/subscription', owner);
      const ends = new Date(`${response.json().trial_ends_on}T00:00:00Z`).getTime();
      const dias = Math.round((ends - Date.now()) / 86_400_000);

      expect(dias).toBeGreaterThanOrEqual(29);
      expect(dias).toBeLessThanOrEqual(30);
    });

    it('prévia de fatura de um mês sem fatura emitida', async () => {
      await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
      await openPeriod(cnpj, '2027-05');

      const response = await call('GET', '/v1/subscription/invoices/2027-05', owner);

      expect(response.json()).toMatchObject({ reference_month: '2027-05', status: 'preview' });
    });

    it('recusa competência malformada na prévia', async () => {
      expect((await call('GET', '/v1/subscription/invoices/2027-13', owner)).statusCode).toBe(400);
    });
  });

  describe('cancelamento em um clique', () => {
    it('cancela sem pergunta, sem retenção e diz o que continua acessível', async () => {
      await call('GET', '/v1/subscription', owner);

      const response = await call('POST', '/v1/subscription/cancel', owner, {
        reason: 'Fechei o escritório',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('canceled');
      expect(response.json().message).toMatch(/trilha de auditoria continuam acessíveis/);
    });

    it('somente owner cancela', async () => {
      await call('GET', '/v1/subscription', owner);

      expect((await call('POST', '/v1/subscription/cancel', accountant, {})).statusCode).toBe(403);
    });

    /** Cancelar não apaga: o event log do cliente é trilha fiscal. */
    it('o cancelamento registra motivo e preserva os dados do cliente', async () => {
      await createClient(pool, tenantId, cnpj);
      await call('GET', '/v1/subscription', owner);
      await call('POST', '/v1/subscription/cancel', owner, { reason: 'Custo' });

      const { rows: assinatura } = await pool.query<{ cancel_reason: string }>(
        'select cancel_reason from subscriptions where tenant_id = $1::uuid',
        [tenantId],
      );
      const { rows: clientes } = await pool.query(
        'select 1 from clients where tenant_id = $1::uuid and cnpj = $2',
        [tenantId, cnpj],
      );

      expect(assinatura[0]!.cancel_reason).toBe('Custo');
      expect(clientes).toHaveLength(1);
    });

    it('404 quando não há assinatura', async () => {
      expect((await call('POST', '/v1/subscription/cancel', owner, {})).statusCode).toBe(404);
    });
  });

  describe('webhook do Asaas', () => {
    // `null` em vez de `undefined` para "sem cabeçalho": passar undefined a um
    // parâmetro com valor default ativa o default, e o teste enviaria o token
    // válido acreditando não enviar nenhum.
    /** Id de evento novo a cada uso: `external_id` é único globalmente. */
    const eventId = () => `evt_${randomUUID()}`;
    const paymentId = () => `pay_${randomUUID()}`;

    const post = (body: unknown, token: string | null = WEBHOOK_TOKEN) =>
      app.inject({
        method: 'POST',
        url: '/v1/webhooks/asaas',
        headers: token === null ? {} : { 'asaas-access-token': token },
        payload: body as Record<string, unknown>,
      });

    it('recusa webhook sem o token do gateway', async () => {
      const response = await post({ id: eventId(), event: 'PAYMENT_RECEIVED' }, 'token-errado');

      expect(response.statusCode).toBe(401);
    });

    it('recusa webhook sem cabeçalho algum', async () => {
      expect((await post({ id: eventId(), event: 'PAYMENT_RECEIVED' }, null)).statusCode).toBe(401);
    });

    it('processa pagamento recebido e ativa a assinatura', async () => {
      const pagamento = paymentId();
      await call('GET', '/v1/subscription', owner);
      await pool.query(
        `insert into invoices (tenant_id, reference_month, total_cents, snapshot, asaas_payment_id)
         values ($1::uuid, '2027-01', 15000, '{}'::jsonb, $2)`,
        [tenantId, pagamento],
      );

      const response = await post({
        id: eventId(),
        event: 'PAYMENT_RECEIVED',
        payment: { id: pagamento, externalReference: tenantId },
      });

      expect(response.json().status).toBe('processed');

      const { rows: fatura } = await pool.query<{ status: string }>(
        'select status from invoices where asaas_payment_id = $1',
        [pagamento],
      );
      const { rows: assinatura } = await pool.query<{ status: string }>(
        'select status from subscriptions where tenant_id = $1::uuid',
        [tenantId],
      );

      expect(fatura[0]!.status).toBe('paid');
      expect(assinatura[0]!.status).toBe('active');
    });

    /**
     * O Asaas reentrega. Processar duas vezes um PAYMENT_RECEIVED marcaria a
     * fatura como paga duas vezes — por isso a idempotência é pelo id do evento.
     */
    it('reentrega do mesmo evento é ignorada, com 200', async () => {
      const duplicado = eventId();
      const body = {
        id: duplicado,
        event: 'PAYMENT_RECEIVED',
        payment: { id: paymentId(), externalReference: tenantId },
      };

      expect((await post(body)).json().status).toBe('processed');
      const segunda = await post(body);

      expect(segunda.statusCode).toBe(200);
      expect(segunda.json().status).toBe('duplicate_ignored');

      const { rows } = await pool.query<{ total: string }>(
        'select count(*)::text as total from billing_events where external_id = $1',
        [duplicado],
      );
      expect(rows[0]!.total).toBe('1');
    });

    it('marca fatura em atraso e assinatura como past_due', async () => {
      const pagamento = paymentId();
      await call('GET', '/v1/subscription', owner);
      await pool.query(
        `insert into invoices (tenant_id, reference_month, total_cents, snapshot, asaas_payment_id)
         values ($1::uuid, '2027-02', 15000, '{}'::jsonb, $2)`,
        [tenantId, pagamento],
      );

      await post({
        id: eventId(),
        event: 'PAYMENT_OVERDUE',
        payment: { id: pagamento, externalReference: tenantId },
      });

      const { rows } = await pool.query<{ status: string }>(
        'select status from subscriptions where tenant_id = $1::uuid',
        [tenantId],
      );
      expect(rows[0]!.status).toBe('past_due');
    });

    /** O Asaas acrescenta tipos; tratar tipo novo como erro derrubaria o webhook. */
    it('evento desconhecido é guardado sem efeito e sem erro', async () => {
      const novoTipo = eventId();
      const response = await post({
        id: novoTipo,
        event: 'PAYMENT_AWAITING_RISK_ANALYSIS',
        payment: { id: paymentId(), externalReference: tenantId },
      });

      expect(response.statusCode).toBe(200);
      const { rows } = await pool.query('select 1 from billing_events where external_id = $1', [
        novoTipo,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('não reativa assinatura já cancelada', async () => {
      await call('GET', '/v1/subscription', owner);
      await call('POST', '/v1/subscription/cancel', owner, {});

      await post({
        id: eventId(),
        event: 'PAYMENT_RECEIVED',
        payment: { id: paymentId(), externalReference: tenantId },
      });

      const { rows } = await pool.query<{ status: string }>(
        'select status from subscriptions where tenant_id = $1::uuid',
        [tenantId],
      );
      expect(rows[0]!.status).toBe('canceled');
    });
  });
});
