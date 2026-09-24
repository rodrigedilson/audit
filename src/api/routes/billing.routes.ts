import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { BillingService } from '../../billing/billing.service.js';
import { BillingActivationService } from '../../billing/billing-activation.service.js';
import type { BillingType } from '../../billing/asaas-client.js';
import { quoteFromCounts, formatBRL, serializeQuote } from '../../billing/pricing.js';
import { REGIMES, type Regime } from '../../fiscal/shared/fiscal-vocabulary.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { createBurstLimiter, exigirLimite } from '../plugins/rate-limit.js';
import { assertValidSchedule } from '../../billing/volume-tiers.js';

const PERIOD_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2])$';

/** Teto da simulação pública. Cobre a maior carteira plausível com folga. */
const MAX_CNPJS_SIMULADOS = 20000;

interface ActivationBody {
  document: string;
  email: string;
  billing_type: BillingType;
}

interface CalculatorBody {
  clients: { regime: Regime; quantity: number }[];
}

/**
 * Planos, assinatura e cobrança.
 *
 * Duas rotas são **públicas** de propósito: o catálogo de planos e a calculadora
 * de preço. O briefing coloca a calculadora no site antes de qualquer contato
 * comercial, e isso é posicionamento — o concorrente esconde preço atrás de
 * formulário.
 */
export async function registerBillingRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const billing = new BillingService(deps.pool);

  // Rotas públicas, e a calculadora faz conta de até 20 mil CNPJs por chamada:
  // sem limite, servia de gerador de carga anônimo.
  const limitePlanos = createBurstLimiter({ windowMs: 60_000, max: 60 });
  const limiteCalculadora = createBurstLimiter({ windowMs: 60_000, max: 30 });

  app.get('/plans', async (request, reply) => {
    exigirLimite([limitePlanos], [request.ip], 'Muitas consultas seguidas. Aguarde alguns instantes.');
    const rules = await billing.pricingRules();
    // A escada é validada antes de ir para a página de preço: publicada inválida,
    // a vitrine prometeria um desconto que o faturamento depois recusa.
    assertValidSchedule(rules.tiers ?? []);
    const { rows } = await deps.pool.query<{ regime: Regime; features: string[] }>(
      'select regime, features from plans',
    );
    const featuresByRegime = new Map(rows.map((row) => [row.regime, row.features]));

    /**
     * Rótulo de cada chave de `features`, para a tela não precisar traduzir
     * `saude_cadastro` por conta própria. Sem isto, quem constrói o frontend
     * inventa o nome comercial — e foi exatamente o que aconteceu.
     */
    const { rows: labels } = await deps.pool.query<{
      key: string;
      label: string;
      description: string | null;
      sort_order: number;
    }>('select key, label, description, sort_order from plan_features order by sort_order, key');

    return reply.code(200).send({
      minimum_cents: rules.minimumCents,
      minimum_formatted: formatBRL(rules.minimumCents),
      // A escada também é pública: esconder o desconto de volume atrás de
      // "fale com um consultor" seria a mesma opacidade que esconder o preço.
      cap_cents: rules.capCents ?? null,
      feature_labels: Object.fromEntries(
        labels.map((row) => [
          row.key,
          { label: row.label, description: row.description, sort_order: row.sort_order },
        ]),
      ),
      tiers: (rules.tiers ?? []).map((tier) => ({
        from_clients: tier.fromClients,
        discount_bps: tier.discountBps,
        label: tier.label ?? null,
      })),
      plans: rules.prices.map((price) => ({
        regime: price.regime,
        monthly_cents: price.monthlyCents,
        monthly_formatted: formatBRL(price.monthlyCents),
        features: featuresByRegime.get(price.regime) ?? [],
      })),
    });
  });

  /**
   * Calculadora pública: quantos CNPJs de cada regime → quanto custa. Devolve as
   * linhas e o ajuste de mínimo separados, para a tela poder explicar a conta em
   * vez de só mostrar um total.
   */
  app.post<{ Body: CalculatorBody }>(
    '/price-calculator',
    {
      schema: {
        body: {
          type: 'object',
          required: ['clients'],
          properties: {
            clients: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: {
                type: 'object',
                required: ['regime', 'quantity'],
                properties: {
                  regime: { type: 'string', enum: [...REGIMES] },
                  /**
                   * 10.000 por regime, e a soma é conferida no handler (o schema
                   * não soma). O custo do cálculo passou a ser O(regimes × faixas)
                   * em vez de O(quantidade) — antes a rota materializava um objeto
                   * por CNPJ só para contá-los de volta —, então o teto existe
                   * para limitar o absurdo, não para conter carga.
                   */
                  quantity: { type: 'integer', minimum: 0, maximum: 10000 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      exigirLimite([limiteCalculadora], [request.ip], 'Muitos cálculos seguidos. Aguarde alguns instantes.');
      const total = request.body.clients.reduce((soma, entry) => soma + entry.quantity, 0);
      if (total > MAX_CNPJS_SIMULADOS) {
        throw new ValidationError(
          1,
          'schema_violation',
          `A calculadora simula no máximo ${MAX_CNPJS_SIMULADOS} CNPJs por vez.`,
        );
      }

      // Sem escritório: a calculadora pública usa o teto global de propósito.
      const rules = await billing.pricingRules();

      const result = quoteFromCounts(
        request.body.clients.map((entry) => ({ regime: entry.regime, quantity: entry.quantity })),
        rules,
      );

      return reply.code(200).send({
        ...serializeQuote(result),
        minimum_cents: rules.minimumCents,
      });
    },
  );

  app.get('/subscription', async (request, reply) => {
    const { tenantId } = request.tenant;

    const subscription = (await billing.subscriptionFor(tenantId)) ?? (await billing.startTrial(tenantId));
    const referenceMonth = currentMonth();
    const result = await billing.quoteFor(tenantId, referenceMonth);

    return reply.code(200).send({
      status: subscription.status,
      trial_ends_on: subscription.trialEndsOn,
      canceled_at: subscription.canceledAt,
      // Sem ativação não há cobrança: o trial acaba sem virar fatura.
      billing_activated: subscription.asaasSubscriptionId !== null,
      reference_month: referenceMonth,
      ...serializeQuote(result),
    });
  });

  /** Prévia da fatura de qualquer mês, para conferência antes do vencimento. */
  app.get<{ Params: { period: string } }>(
    '/subscription/invoices/:period',
    {
      schema: {
        params: {
          type: 'object',
          required: ['period'],
          properties: { period: { type: 'string', pattern: PERIOD_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.tenant;
      const { period } = request.params;

      const { rows } = await deps.pool.query<{
        total_cents: number;
        status: string;
        snapshot: unknown;
        due_date: Date | null;
        paid_at: Date | null;
      }>(
        `select total_cents, status, snapshot, due_date, paid_at
           from invoices where tenant_id = $1::uuid and reference_month = $2::char(7)`,
        [tenantId, period],
      );

      const emitted = rows[0];
      if (emitted) {
        return reply.code(200).send({
          reference_month: period,
          status: emitted.status,
          total_cents: emitted.total_cents,
          total_formatted: formatBRL(emitted.total_cents),
          due_date: emitted.due_date ? emitted.due_date.toISOString().slice(0, 10) : null,
          paid_at: emitted.paid_at?.toISOString() ?? null,
          // A fatura emitida guarda a cotação que a originou: continua explicável
          // mesmo depois de o preço da tabela mudar.
          snapshot: emitted.snapshot,
        });
      }

      const result = await billing.quoteFor(tenantId, period);
      return reply.code(200).send({
        reference_month: period,
        status: 'preview',
        ...serializeQuote(result),
      });
    },
  );

  /**
   * Ativação da cobrança pelo owner: CPF/CNPJ, e-mail e forma de pagamento.
   * Cria o cliente e a assinatura no Asaas. Pós-pago: o primeiro mês cobrado é
   * o primeiro mês cheio depois do trial e da ativação, com vencimento no mês
   * seguinte a ele.
   */
  app.post<{ Body: ActivationBody }>(
    '/subscription/activate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['document', 'email', 'billing_type'],
          additionalProperties: false,
          properties: {
            document: { type: 'string', minLength: 11, maxLength: 18 },
            email: { type: 'string', format: 'email', maxLength: 254 },
            billing_type: { type: 'string', enum: ['PIX', 'BOLETO', 'CREDIT_CARD', 'UNDEFINED'] },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);

      if (deps.asaas === undefined) {
        return reply.code(503).send({
          code: 'billing_gateway_not_configured',
          message:
            'Gateway de cobrança não configurado neste ambiente. Em dev isso é esperado: ' +
            'o banco é compartilhado com produção, e dev não fala com o Asaas.',
        });
      }

      const activation = await new BillingActivationService(deps.pool, deps.asaas).activate(
        context.tenantId,
        {
          document: request.body.document,
          email: request.body.email,
          billingType: request.body.billing_type,
        },
        new Date().toISOString().slice(0, 10),
      );

      return reply.code(activation.alreadyActive ? 200 : 201).send({
        already_active: activation.alreadyActive,
        first_due_date: activation.firstDueDate,
        first_reference_month: activation.firstReferenceMonth,
        estimate_cents: activation.estimateCents,
        estimate_formatted: formatBRL(activation.estimateCents),
        message:
          `A primeira fatura cobra ${activation.firstReferenceMonth} e vence em ` +
          `${activation.firstDueDate}. O valor é fechado quando o mês de referência acaba.`,
      });
    },
  );

  /**
   * Cancelamento em um clique, dentro do produto, sem retenção por telefone —
   * é o contraponto explícito à reclamação de "cancelamento difícil" que o
   * briefing usa como posicionamento. Só `owner`.
   */
  app.post<{ Body: { reason?: string } }>(
    '/subscription/cancel',
    {
      schema: {
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertIsOwner(context);

      const subscription = await billing.subscriptionFor(context.tenantId);
      if (!subscription) {
        throw new NotFoundError('Este escritório não tem assinatura.');
      }

      if (subscription.asaasSubscriptionId && deps.asaas) {
        await deps.asaas.cancelSubscription(subscription.asaasSubscriptionId);
      }

      const canceled = await billing.cancel(context.tenantId, request.body?.reason);

      return reply.code(200).send({
        status: canceled.status,
        canceled_at: canceled.canceledAt,
        // Nem cobrança pendente, nem pergunta, nem telefone: a resposta diz o
        // que aconteceu e o que continua disponível.
        message:
          'Assinatura cancelada. Seus dados e a trilha de auditoria continuam acessíveis ' +
          'até o fim do período já pago.',
      });
    },
  );
}

/**
 * Webhook do Asaas.
 *
 * Público quanto a JWT (o gateway não tem sessão), autenticado por token no
 * cabeçalho `asaas-access-token`, que é o mecanismo que o Asaas oferece.
 * Idempotente pelo id do evento: o Asaas reentrega, e processar duas vezes um
 * `PAYMENT_RECEIVED` marcaria a fatura como paga duas vezes.
 */
export async function registerBillingWebhook(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const billing = new BillingService(deps.pool);

  app.post<{ Body: AsaasWebhookBody }>(
    '/webhooks/asaas',
    {
      schema: {
        body: {
          type: 'object',
          required: ['event'],
          properties: {
            id: { type: 'string' },
            event: { type: 'string' },
            payment: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const expected = deps.env.asaasWebhookToken;
      const received = request.headers['asaas-access-token'];

      // Sem token configurado o webhook não fica aberto: é desligado. Aceitar
      // qualquer POST em produção deixaria um estranho marcar faturas como pagas.
      if (!expected) {
        return reply.code(503).send({
          code: 'webhook_disabled',
          message: 'Webhook de cobrança não configurado.',
        });
      }
      if (received !== expected) {
        return reply.code(401).send({ code: 'unauthorized', message: 'Token do webhook inválido.' });
      }

      const body = request.body;

      // Reentrega é normal, não erro: responder 200 evita o Asaas insistir.
      if (body.id !== undefined && (await billing.billingEventExists(body.id))) {
        return reply.code(200).send({ status: 'duplicate_ignored' });
      }

      const tenantId = await tenantOfWebhook(deps, body);

      // O efeito vem ANTES do registro. Gravar primeiro fazia uma falha no meio
      // (o Asaas fora do ar ao ajustar o valor, por exemplo) virar evento
      // "processado": a reentrega era ignorada como duplicata e a fatura do mês
      // nunca era gravada. Os efeitos são idempotentes, então reprocessar é
      // seguro; perder o evento, não.
      await applyPaymentEffect(deps, body, tenantId);

      await billing.recordBillingEvent(
        tenantId,
        body.event,
        body as unknown as Record<string, unknown>,
        body.id,
      );

      return reply.code(200).send({ status: 'processed' });
    },
  );
}

interface AsaasWebhookBody {
  id?: string;
  event: string;
  payment?: {
    id?: string;
    subscription?: string;
    externalReference?: string;
    value?: number;
    dueDate?: string;
    paymentDate?: string;
  };
}

/** Tenant do evento: `externalReference`, ou a assinatura quando ela faltar. */
async function tenantOfWebhook(deps: ApiDeps, body: AsaasWebhookBody): Promise<string | null> {
  const externalReference = body.payment?.externalReference;
  if (isUuid(externalReference)) {
    return externalReference;
  }
  const subscriptionId = body.payment?.subscription;
  if (subscriptionId === undefined) {
    return null;
  }
  const { rows } = await deps.pool.query<{ tenant_id: string }>(
    'select tenant_id from subscriptions where asaas_subscription_id = $1',
    [subscriptionId],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * Efeito de cada evento sobre a fatura e a assinatura. Eventos desconhecidos são
 * guardados em `billing_events` e não fazem nada: o Asaas acrescenta tipos, e
 * tratar um tipo novo como erro derrubaria o webhook.
 */
async function applyPaymentEffect(
  deps: ApiDeps,
  body: AsaasWebhookBody,
  tenantId: string | null,
): Promise<void> {
  const paymentId = body.payment?.id;
  if (!paymentId) {
    return;
  }

  // A cobrança do mês nasceu com a estimativa: fecha o valor pelo mês de
  // referência e grava a fatura, que é o que os eventos seguintes atualizam.
  if (body.event === 'PAYMENT_CREATED') {
    if (deps.asaas === undefined) {
      throw new Error('PAYMENT_CREATED recebido sem gateway configurado para fechar o valor.');
    }
    await new BillingActivationService(deps.pool, deps.asaas).closeInvoice({
      ...body.payment,
      id: paymentId,
      ...(tenantId === null ? {} : { externalReference: tenantId }),
    });
    return;
  }

  if (body.event === 'PAYMENT_RECEIVED' || body.event === 'PAYMENT_CONFIRMED') {
    await deps.pool.query(
      `update invoices set status = 'paid', paid_at = now() where asaas_payment_id = $1`,
      [paymentId],
    );
    if (tenantId) {
      await deps.pool.query(
        `update subscriptions set status = 'active', updated_at = now()
          where tenant_id = $1::uuid and status <> 'canceled'`,
        [tenantId],
      );
    }
    return;
  }

  if (body.event === 'PAYMENT_OVERDUE') {
    await deps.pool.query(
      `update invoices set status = 'overdue' where asaas_payment_id = $1`,
      [paymentId],
    );
    if (tenantId) {
      await deps.pool.query(
        `update subscriptions set status = 'past_due', updated_at = now()
          where tenant_id = $1::uuid and status <> 'canceled'`,
        [tenantId],
      );
    }
  }
}

function isUuid(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
