import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import type {
  AsaasCustomerInput,
  AsaasGateway,
  AsaasSubscriptionInput,
} from '../../src/billing/asaas-client.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const WEBHOOK_TOKEN = 'token-do-webhook-de-teste';
const AUDIENCE = 'authenticated';

/**
 * Gateway dublado. Grava o que a aplicação pediu ao Asaas: é o que estes testes
 * conferem — a aplicação, não o Asaas.
 */
class GatewayDublado implements AsaasGateway {
  customers: AsaasCustomerInput[] = [];
  subscriptions: AsaasSubscriptionInput[] = [];
  paymentValues: { paymentId: string; valueCents: number }[] = [];
  deletedPayments: string[] = [];
  subscriptionValues: { subscriptionId: string; valueCents: number }[] = [];
  falharAssinatura = false;
  seq = 0;

  async createCustomer(input: AsaasCustomerInput): Promise<string> {
    this.customers.push(input);
    return `cus_${++this.seq}`;
  }

  async createSubscription(input: AsaasSubscriptionInput): Promise<string> {
    if (this.falharAssinatura) {
      throw new Error('Asaas fora do ar');
    }
    this.subscriptions.push(input);
    return `sub_${++this.seq}_${input.externalReference.slice(0, 8)}`;
  }

  async updatePaymentValue(paymentId: string, valueCents: number): Promise<void> {
    this.paymentValues.push({ paymentId, valueCents });
  }

  async deletePayment(paymentId: string): Promise<void> {
    this.deletedPayments.push(paymentId);
  }

  async updateSubscriptionValue(subscriptionId: string, valueCents: number): Promise<void> {
    this.subscriptionValues.push({ subscriptionId, valueCents });
  }

  async cancelSubscription(): Promise<void> {}
}

describe.skipIf(!DATABASE_URL)('API — ativação da cobrança e fechamento da fatura', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let semGateway: FastifyInstance;
  let gateway: GatewayDublado;
  let tenantId: string;
  let owner: string;
  let accountant: string;

  const token = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const ativar = async (userId: string, body: Record<string, unknown>, servidor = app) =>
    servidor.inject({
      method: 'POST',
      url: '/v1/subscription/activate',
      headers: { authorization: `Bearer ${await token(userId)}` },
      payload: body,
    });

  const webhook = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/webhooks/asaas',
      headers: { 'asaas-access-token': WEBHOOK_TOKEN },
      payload,
    });

  const DADOS = { document: '11.222.333/0001-81', email: 'financeiro@escritorio.com.br', billing_type: 'PIX' };

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

    gateway = new GatewayDublado();
    app = await buildServer({ env, pool, asaas: gateway });
    semGateway = await buildServer({ env, pool });
    await Promise.all([app.ready(), semGateway.ready()]);
  });

  afterAll(async () => {
    await app?.close();
    await semGateway?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    tenantId = await createTenant(pool, 'Escritório Ativação');
    owner = await createMembership(pool, tenantId, 'owner');
    accountant = await createMembership(pool, tenantId, 'accountant');
    gateway.customers = [];
    gateway.subscriptions = [];
    gateway.paymentValues = [];
    gateway.deletedPayments = [];
    gateway.subscriptionValues = [];
    gateway.falharAssinatura = false;
    gateway.seq = 0;
  });

  describe('ativação', () => {
    /** O Asaas não cria assinatura de valor zero. */
    it('sem CNPJ ativo ainda, a assinatura nasce com o mínimo como estimativa', async () => {
      await ativar(owner, DADOS);

      expect(gateway.subscriptions[0]!.valueCents).toBe(15_000);
    });

    it('cria cliente e assinatura no Asaas, com o tenant como referência', async () => {
      const r = await ativar(owner, DADOS);

      expect(r.statusCode).toBe(201);
      expect(gateway.customers).toEqual([
        { name: 'Escritório Ativação', cpfCnpj: '11222333000181', email: 'financeiro@escritorio.com.br' },
      ]);
      expect(gateway.subscriptions).toHaveLength(1);
      expect(gateway.subscriptions[0]).toMatchObject({
        customerId: 'cus_1',
        billingType: 'PIX',
        externalReference: tenantId,
        nextDueDate: r.json().first_due_date,
      });
    });

    /** O trial dura 30 dias: o primeiro mês cobrado é o primeiro cheio depois dele. */
    it('o primeiro mês cobrado não tem dia de trial', async () => {
      const r = await ativar(owner, DADOS);
      const { rows } = await pool.query<{ trial_ends_on: Date }>(
        'select trial_ends_on from subscriptions where tenant_id = $1::uuid',
        [tenantId],
      );
      const fimDoTrial = rows[0]!.trial_ends_on.toISOString().slice(0, 7);

      expect(r.json().first_reference_month > fimDoTrial).toBe(true);
      expect(r.json().first_due_date.endsWith('-10')).toBe(true);
    });

    it('grava os dados de cobrança e o evento, fora do log fiscal', async () => {
      await ativar(owner, DADOS);

      const { rows } = await pool.query(
        `select billing_document, billing_email, billing_type, asaas_customer_id,
                asaas_subscription_id, billing_day, activated_at
           from subscriptions where tenant_id = $1::uuid`,
        [tenantId],
      );
      expect(rows[0]).toMatchObject({
        billing_document: '11222333000181',
        billing_type: 'PIX',
        asaas_customer_id: 'cus_1',
        billing_day: 10,
      });
      expect(rows[0].activated_at).not.toBeNull();

      const eventos = await pool.query(
        "select kind from billing_events where tenant_id = $1::uuid and kind = 'subscription.activated'",
        [tenantId],
      );
      expect(eventos.rowCount).toBe(1);
      const fiscais = await pool.query('select 1 from events where tenant_id = $1::uuid', [tenantId]);
      expect(fiscais.rowCount).toBe(0);
    });

    it('ativar de novo não cria segundo cliente nem segunda assinatura', async () => {
      await ativar(owner, DADOS);
      const r = await ativar(owner, DADOS);

      expect(r.statusCode).toBe(200);
      expect(r.json().already_active).toBe(true);
      expect(gateway.customers).toHaveLength(1);
      expect(gateway.subscriptions).toHaveLength(1);
    });

    /** Se a assinatura falhar, a nova tentativa reaproveita o cliente já criado. */
    it('falha no meio não duplica o cliente no Asaas', async () => {
      gateway.falharAssinatura = true;
      const falha = await ativar(owner, DADOS);
      expect(falha.statusCode).toBe(500);

      gateway.falharAssinatura = false;
      const r = await ativar(owner, DADOS);

      expect(r.statusCode).toBe(201);
      expect(gateway.customers).toHaveLength(1);
      expect(gateway.subscriptions[0]!.customerId).toBe('cus_1');
    });

    it('só owner ativa', async () => {
      expect((await ativar(accountant, DADOS)).statusCode).toBe(403);
      expect(gateway.customers).toHaveLength(0);
    });

    it('recusa CPF/CNPJ com dígito verificador errado, antes de falar com o Asaas', async () => {
      const r = await ativar(owner, { ...DADOS, document: '11222333000182' });

      expect(r.statusCode).toBe(400);
      expect(gateway.customers).toHaveLength(0);
    });

    it('recusa forma de pagamento fora da lista', async () => {
      expect((await ativar(owner, { ...DADOS, billing_type: 'CHEQUE' })).statusCode).toBe(400);
    });

    it('assinatura cancelada não é reativada por aqui', async () => {
      await pool.query(
        `insert into subscriptions (tenant_id, status, canceled_at) values ($1::uuid, 'canceled', now())`,
        [tenantId],
      );

      expect((await ativar(owner, DADOS)).statusCode).toBe(409);
      expect(gateway.customers).toHaveLength(0);
    });

    /** Dev não tem chave do Asaas: o banco é o de produção. */
    it('sem gateway, 503 dizendo por quê', async () => {
      const r = await ativar(owner, DADOS, semGateway);

      expect(r.statusCode).toBe(503);
      expect(r.json().code).toBe('billing_gateway_not_configured');
    });

    it('GET /subscription diz se a cobrança foi ativada', async () => {
      const antes = await app.inject({
        method: 'GET',
        url: '/v1/subscription',
        headers: { authorization: `Bearer ${await token(owner)}` },
      });
      expect(antes.json().billing_activated).toBe(false);

      await ativar(owner, DADOS);
      const depois = await app.inject({
        method: 'GET',
        url: '/v1/subscription',
        headers: { authorization: `Bearer ${await token(owner)}` },
      });
      expect(depois.json().billing_activated).toBe(true);
    });
  });

  describe('fechamento da fatura no PAYMENT_CREATED', () => {
    let subscriptionId: string;
    // O banco de teste persiste entre execuções, e `external_id` e
    // `asaas_payment_id` são únicos: ids fixos colidiriam na segunda rodada.
    let pagamento: string;
    const evento = (): string => `evt_${randomUUID()}`;

    beforeEach(async () => {
      pagamento = `pay_${randomUUID()}`;
      await ativar(owner, DADOS);
      const { rows } = await pool.query<{ asaas_subscription_id: string }>(
        'select asaas_subscription_id from subscriptions where tenant_id = $1::uuid',
        [tenantId],
      );
      subscriptionId = rows[0]!.asaas_subscription_id;
    });

    /** Dois CNPJs híbridos com competência em outubro: 2 × R$ 29 fica abaixo do mínimo. */
    const carteiraDeOutubro = async (): Promise<void> => {
      for (let i = 0; i < 2; i += 1) {
        const cnpj = randomCnpj();
        await createClient(pool, tenantId, cnpj, { regime: 'simples_hibrido' });
        await pool.query(
          `insert into periods (tenant_id, cnpj, period, state) values ($1::uuid, $2::char(14), '2026-10', 'open')`,
          [tenantId, cnpj],
        );
      }
    };

    const criada = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      event: 'PAYMENT_CREATED',
      payment: { id: pagamento, subscription: subscriptionId, dueDate: '2026-11-10', value: 1, ...extra },
    });

    it('fecha o valor pelo mês anterior ao vencimento e grava a fatura com a cotação', async () => {
      await carteiraDeOutubro();

      const r = await webhook(criada(evento()));

      expect(r.statusCode).toBe(200);
      const { rows } = await pool.query(
        `select reference_month, total_cents, status, due_date, snapshot
           from invoices where tenant_id = $1::uuid`,
        [tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reference_month: '2026-10', total_cents: 15_000, status: 'pending' });
      expect(rows[0].snapshot).toMatchObject({
        reference_month: '2026-10',
        billable_clients: 2,
        subtotal_cents: 5800,
        minimum_adjustment_cents: 9200,
      });
    });

    it('corrige no Asaas o valor da cobrança e da assinatura quando a estimativa errou', async () => {
      await carteiraDeOutubro();
      await webhook(criada(evento()));

      expect(gateway.paymentValues).toEqual([{ paymentId: pagamento, valueCents: 15_000 }]);
      expect(gateway.subscriptionValues).toEqual([{ subscriptionId, valueCents: 15_000 }]);
    });

    it('estimativa certa não gera chamada ao Asaas', async () => {
      await carteiraDeOutubro();
      await webhook(criada(evento(), { value: 150 }));

      expect(gateway.paymentValues).toEqual([]);
    });

    /** Carteira vazia não paga piso: cobrar mínimo de quem não tem CNPJ ativo é cobrança indevida. */
    it('mês sem CNPJ ativo: a cobrança sai do Asaas e a fatura fica cancelada', async () => {
      await webhook(criada(evento()));

      expect(gateway.deletedPayments).toEqual([pagamento]);
      expect(gateway.paymentValues).toEqual([]);
      const { rows } = await pool.query(
        'select status, total_cents, snapshot from invoices where tenant_id = $1::uuid',
        [tenantId],
      );
      expect(rows[0]).toMatchObject({ status: 'canceled', total_cents: 0 });
      expect(rows[0].snapshot.billable_clients).toBe(0);
    });

    it('acha o escritório pela assinatura, mesmo sem externalReference', async () => {
      await webhook(criada(evento()));

      const { rowCount } = await pool.query('select 1 from invoices where tenant_id = $1::uuid', [tenantId]);
      expect(rowCount).toBe(1);
    });

    it('reentrega não grava segunda fatura', async () => {
      const id = evento();
      await webhook(criada(id));
      const r = await webhook(criada(id));

      expect(r.json().status).toBe('duplicate_ignored');
      const { rowCount } = await pool.query('select 1 from invoices where tenant_id = $1::uuid', [tenantId]);
      expect(rowCount).toBe(1);
    });

    /** O pagamento só marca a fatura porque o PAYMENT_CREATED a gravou com o id. */
    it('o PAYMENT_RECEIVED seguinte encontra a fatura e a marca paga', async () => {
      await webhook(criada(evento()));
      await webhook({ id: evento(), event: 'PAYMENT_RECEIVED', payment: { id: pagamento, subscription: subscriptionId } });

      const { rows } = await pool.query('select status, paid_at from invoices where tenant_id = $1::uuid', [tenantId]);
      expect(rows[0].status).toBe('paid');
      expect(rows[0].paid_at).not.toBeNull();
    });
  });
});
