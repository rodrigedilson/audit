import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { BillingService } from '../../billing/billing.service.js';
import { quote, formatBRL, type BillableClient } from '../../billing/pricing.js';
import { REGIMES, type Regime } from '../../fiscal/shared/fiscal-vocabulary.js';
import { NotFoundError } from '../auth/tenant-resolver.js';

const PERIOD_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2])$';

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

  app.get('/plans', async (_request, reply) => {
    const rules = await billing.pricingRules();
    const { rows } = await deps.pool.query<{ regime: Regime; features: string[] }>(
      'select regime, features from plans',
    );
    const featuresByRegime = new Map(rows.map((row) => [row.regime, row.features]));

    return reply.code(200).send({
      minimum_cents: rules.minimumCents,
      minimum_formatted: formatBRL(rules.minimumCents),
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
                  // 2000 cobre o público-alvo (20 a 300 CNPJs) com folga e evita
                  // a rota ser usada para gerar carga.
                  quantity: { type: 'integer', minimum: 0, maximum: 2000 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rules = await billing.pricingRules();

      const clients: BillableClient[] = request.body.clients.flatMap((entry) =>
        Array.from({ length: entry.quantity }, (_, index) => ({
          cnpj: `simulado-${entry.regime}-${index}`,
          regime: entry.regime,
        })),
      );

      const result = quote(clients, rules);

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
      const externalReference = body.payment?.externalReference;
      const tenantId = isUuid(externalReference) ? externalReference : null;

      const isNew = await billing.recordBillingEvent(
        tenantId,
        body.event,
        body as unknown as Record<string, unknown>,
        body.id,
      );

      // Reentrega é normal, não erro: responder 200 evita o Asaas insistir.
      if (!isNew) {
        return reply.code(200).send({ status: 'duplicate_ignored' });
      }

      await applyPaymentEffect(deps, body, tenantId);

      return reply.code(200).send({ status: 'processed' });
    },
  );
}

interface AsaasWebhookBody {
  id?: string;
  event: string;
  payment?: {
    id?: string;
    externalReference?: string;
    value?: number;
    paymentDate?: string;
  };
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

function serializeQuote(result: ReturnType<typeof quote>): Record<string, unknown> {
  return {
    billable_clients: result.billableClients,
    lines: result.lines.map((line) => ({
      regime: line.regime,
      quantity: line.quantity,
      unit_cents: line.unitCents,
      subtotal_cents: line.subtotalCents,
    })),
    subtotal_cents: result.subtotalCents,
    minimum_adjustment_cents: result.minimumAdjustmentCents,
    total_cents: result.totalCents,
    total_formatted: formatBRL(result.totalCents),
  };
}

function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
