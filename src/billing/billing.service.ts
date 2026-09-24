import type { Pool } from 'pg';
import type { Regime } from '../fiscal/shared/fiscal-vocabulary.js';
import { quote, type BillableClient, type PriceQuote, type PricingRules } from './pricing.js';

export interface Subscription {
  tenantId: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  trialEndsOn: string | null;
  asaasCustomerId: string | null;
  asaasSubscriptionId: string | null;
  canceledAt: string | null;
}

/**
 * `billing_settings` sem a linha única. A migration a semeia; faltar é schema
 * aplicado pela metade. Antes, o serviço caía em `15000` e `30` escritos no
 * código: a calculadora pública mostrava um mínimo que não estava em lugar
 * nenhum do banco, e mudar o preço na tabela deixava de ter efeito sem aviso.
 */
export class BillingSettingsMissingError extends Error {
  constructor() {
    super(
      'Parâmetros de cobrança ausentes (billing_settings). Rode `npm run doctor` ' +
        'e aplique a carga de cobrança.',
    );
    this.name = 'BillingSettingsMissingError';
  }
}

/**
 * Lê planos e carteira e produz a cotação do mês. Não fala com o gateway: quem
 * integra é a rota, para que o cálculo do preço continue testável sem rede.
 */
export class BillingService {
  constructor(private readonly pool: Pool) {}

  /**
   * Preço, piso, escada de volume e teto.
   *
   * `tenantId` só é necessário quando o teto do contrato daquele escritório
   * difere do global — a calculadora pública, que não tem escritório, usa o
   * global de propósito: o preço anunciado no site não pode depender de uma
   * negociação que o visitante não fez.
   */
  async pricingRules(tenantId?: string): Promise<PricingRules> {
    const [{ rows: prices }, { rows: settings }, { rows: tiers }] = await Promise.all([
      this.pool.query<{ regime: Regime; monthly_cents: number }>(
        'select regime, monthly_cents from plans order by monthly_cents',
      ),
      this.pool.query<{ minimum_cents: number; cap_cents: number | null }>(
        'select minimum_cents, cap_cents from billing_settings where id = true',
      ),
      this.pool.query<{ from_clients: number; discount_bps: number; label: string | null }>(
        `select from_clients, discount_bps, label
           from pricing_tiers
          where effective_from <= current_date
          order by from_clients`,
      ),
    ]);

    const parametros = exigirParametros(settings);

    const override = tenantId === undefined ? null : await this.capOverrideFor(tenantId);
    const capCents = override ?? parametros.cap_cents;

    return {
      prices: prices.map((row) => ({ regime: row.regime, monthlyCents: row.monthly_cents })),
      minimumCents: parametros.minimum_cents,
      tiers: tiers.map((row) => ({
        fromClients: row.from_clients,
        discountBps: row.discount_bps,
        ...(row.label === null ? {} : { label: row.label }),
      })),
      ...(capCents === null ? {} : { capCents }),
    };
  }

  /** Teto negociado em contrato, quando existe. Nulo cai no teto global. */
  private async capOverrideFor(tenantId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ cap_cents_override: number | null }>(
      'select cap_cents_override from subscriptions where tenant_id = $1::uuid',
      [tenantId],
    );
    return rows[0]?.cap_cents_override ?? null;
  }

  /**
   * CNPJs faturáveis do mês. A definição vive na função SQL `billable_clients`:
   * ativo **e** com competência no mês. Cadastrar e não trabalhar não cobra.
   */
  async billableClients(tenantId: string, referenceMonth: string): Promise<BillableClient[]> {
    const { rows } = await this.pool.query<{ cnpj: string; regime: Regime }>(
      'select cnpj, regime from billable_clients($1::uuid, $2::char(7))',
      [tenantId, referenceMonth],
    );
    return rows.map((row) => ({ cnpj: row.cnpj.trim(), regime: row.regime }));
  }

  async quoteFor(tenantId: string, referenceMonth: string): Promise<PriceQuote> {
    const [clients, rules] = await Promise.all([
      this.billableClients(tenantId, referenceMonth),
      this.pricingRules(tenantId),
    ]);
    return quote(clients, rules);
  }

  async subscriptionFor(tenantId: string): Promise<Subscription | null> {
    const { rows } = await this.pool.query<{
      tenant_id: string;
      status: Subscription['status'];
      trial_ends_on: Date | null;
      asaas_customer_id: string | null;
      asaas_subscription_id: string | null;
      canceled_at: Date | null;
    }>(
      `select tenant_id, status, trial_ends_on, asaas_customer_id,
              asaas_subscription_id, canceled_at
         from subscriptions where tenant_id = $1::uuid`,
      [tenantId],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      tenantId: row.tenant_id,
      status: row.status,
      trialEndsOn: row.trial_ends_on ? toIsoDate(row.trial_ends_on) : null,
      asaasCustomerId: row.asaas_customer_id,
      asaasSubscriptionId: row.asaas_subscription_id,
      canceledAt: row.canceled_at?.toISOString() ?? null,
    };
  }

  /** Cria a assinatura em trial. O gateway só entra quando o trial acaba. */
  async startTrial(tenantId: string): Promise<Subscription> {
    const { rows: settings } = await this.pool.query<{ trial_days: number }>(
      'select trial_days from billing_settings where id = true',
    );
    const trialDays = exigirParametros(settings).trial_days;

    await this.pool.query(
      `insert into subscriptions (tenant_id, status, trial_ends_on)
       values ($1::uuid, 'trialing', current_date + ($2 || ' days')::interval)
       on conflict (tenant_id) do nothing`,
      [tenantId, String(trialDays)],
    );

    return (await this.subscriptionFor(tenantId))!;
  }

  /**
   * Cancelamento em um clique, conforme o briefing. Não apaga a assinatura nem
   * os dados: marca cancelada e registra o motivo. O event log fiscal do cliente
   * continua intacto — é trilha fiscal, e não se apaga porque o escritório saiu.
   */
  async cancel(tenantId: string, reason: string | undefined): Promise<Subscription> {
    await this.pool.query(
      `update subscriptions
          set status = 'canceled', canceled_at = now(), cancel_reason = $2, updated_at = now()
        where tenant_id = $1::uuid`,
      [tenantId, reason ?? null],
    );

    await this.recordBillingEvent(tenantId, 'subscription.canceled', { reason: reason ?? null });

    return (await this.subscriptionFor(tenantId))!;
  }

  /** O webhook já processou este evento do Asaas? */
  async billingEventExists(externalId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'select 1 from billing_events where external_id = $1',
      [externalId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Registra evento de cobrança. `externalId` dá idempotência de webhook: o
   * Asaas reentrega, e processar duas vezes um `PAYMENT_RECEIVED` marcaria a
   * fatura como paga duas vezes.
   *
   * Devolve `false` quando o evento já havia sido processado.
   */
  async recordBillingEvent(
    tenantId: string | null,
    kind: string,
    payload: Record<string, unknown>,
    externalId?: string,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      // O `where` repete o predicado do índice parcial: sem ele o Postgres não
      // consegue inferir qual índice usar e recusa a cláusula inteira.
      `insert into billing_events (tenant_id, kind, payload, external_id)
       values ($1::uuid, $2, $3::jsonb, $4)
       on conflict (external_id) where external_id is not null do nothing`,
      [tenantId, kind, JSON.stringify(payload), externalId ?? null],
    );

    return (rowCount ?? 0) > 0;
  }
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function exigirParametros<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new BillingSettingsMissingError();
  }
  return row;
}
