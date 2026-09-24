import type { Pool } from 'pg';
import type { AsaasGateway, BillingType } from './asaas-client.js';
import { BillingService } from './billing.service.js';
import { documentoValido, mesDeReferencia, primeiroVencimento, DIA_DE_VENCIMENTO } from './billing-schedule.js';
import { serializeQuote } from './pricing.js';

/** A operação não cabe no estado da assinatura — 409 na API. */
export class BillingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConflictError';
  }
}

/** Dado de cobrança recusado na fronteira — 400 na API. */
export class BillingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingInputError';
  }
}

export interface ActivationInput {
  /** CPF ou CNPJ do pagador, com ou sem máscara. */
  document: string;
  email: string;
  billingType: BillingType;
}

export interface Activation {
  alreadyActive: boolean;
  firstDueDate: string;
  firstReferenceMonth: string;
  estimateCents: number;
}

/** O pedaço do payload do Asaas que o fechamento da fatura usa. */
export interface AsaasPayment {
  id: string;
  subscription?: string;
  externalReference?: string;
  dueDate?: string;
  value?: number;
}

export interface InvoiceClosing {
  tenantId: string;
  referenceMonth: string;
  totalCents: number;
  /** O valor que o Asaas gerou era a estimativa e foi corrigido. */
  adjusted: boolean;
  /** O mês fechou sem CNPJ ativo: a cobrança foi removida no Asaas. */
  removed: boolean;
  /** Já havia fatura para o mês: nada foi gravado de novo. */
  duplicate: boolean;
}

/**
 * Ativação da cobrança e fechamento da fatura mensal.
 *
 * Os eventos vão para `billing_events`, e não para o event log fiscal
 * (ADR-004): cobrança é histórico próprio, e misturá-la ao log fiscal poluiria
 * o replay da apuração.
 */
export class BillingActivationService {
  private readonly billing: BillingService;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: AsaasGateway,
  ) {
    this.billing = new BillingService(pool);
  }

  /**
   * O owner informa os dados de cobrança e a assinatura passa a existir no
   * Asaas. Idempotente: ativar de novo devolve o que já existe, sem criar
   * segundo cliente nem segunda assinatura.
   */
  async activate(tenantId: string, input: ActivationInput, hoje: string): Promise<Activation> {
    const document = input.document.replace(/\D/g, '');
    if (!documentoValido(document)) {
      throw new BillingInputError('CPF ou CNPJ inválido: confira os dígitos verificadores.');
    }

    const subscription =
      (await this.billing.subscriptionFor(tenantId)) ?? (await this.billing.startTrial(tenantId));
    if (subscription.status === 'canceled') {
      throw new BillingConflictError(
        'A assinatura está cancelada. Reativar exige uma assinatura nova, que ainda não é oferecida.',
      );
    }

    const firstDueDate = primeiroVencimento(subscription.trialEndsOn, hoje);
    const firstReferenceMonth = mesDeReferencia(firstDueDate);

    if (subscription.asaasSubscriptionId !== null) {
      return {
        alreadyActive: true,
        firstDueDate,
        firstReferenceMonth,
        estimateCents: (await this.billing.quoteFor(tenantId, hoje.slice(0, 7))).totalCents,
      };
    }

    const { rows } = await this.pool.query<{ name: string }>(
      'select name from tenants where id = $1::uuid',
      [tenantId],
    );

    // O cliente é gravado antes da assinatura: se a criação da assinatura
    // falhar, a nova tentativa reaproveita o cliente em vez de duplicá-lo no
    // Asaas.
    const customerId =
      subscription.asaasCustomerId ??
      (await this.gateway.createCustomer({ name: rows[0]!.name, cpfCnpj: document, email: input.email }));
    await this.pool.query(
      `update subscriptions
          set asaas_customer_id = $2, billing_document = $3, billing_email = $4,
              billing_type = $5, updated_at = now()
        where tenant_id = $1::uuid`,
      [tenantId, customerId, document, input.email, input.billingType],
    );

    // Estimativa pela carteira do mês corrente. O valor de cada cobrança é
    // fechado no `PAYMENT_CREATED`, com o mês de referência já encerrado. Sem
    // CNPJ ativo ainda, a estimativa seria zero, e o Asaas não cria assinatura
    // de valor zero: o mínimo entra como provisório, e é corrigido — ou a
    // cobrança removida — quando o mês fechar.
    const cotado = (await this.billing.quoteFor(tenantId, hoje.slice(0, 7))).totalCents;
    const estimateCents = cotado > 0 ? cotado : (await this.billing.pricingRules()).minimumCents;
    const subscriptionId = await this.gateway.createSubscription({
      customerId,
      valueCents: estimateCents,
      nextDueDate: firstDueDate,
      billingType: input.billingType,
      description: 'audit — assinatura mensal por CNPJ ativo',
      externalReference: tenantId,
    });

    await this.pool.query(
      `update subscriptions
          set asaas_subscription_id = $2, billing_day = $3, activated_at = now(), updated_at = now()
        where tenant_id = $1::uuid`,
      [tenantId, subscriptionId, DIA_DE_VENCIMENTO],
    );
    await this.billing.recordBillingEvent(tenantId, 'subscription.activated', {
      billing_type: input.billingType,
      first_due_date: firstDueDate,
      first_reference_month: firstReferenceMonth,
      estimate_cents: estimateCents,
      asaas_customer_id: customerId,
      asaas_subscription_id: subscriptionId,
    });

    return { alreadyActive: false, firstDueDate, firstReferenceMonth, estimateCents };
  }

  /**
   * O Asaas gerou a cobrança do mês. Fecha o valor pela carteira do mês de
   * referência — o anterior ao vencimento, já encerrado — e grava a fatura com
   * a cotação que a originou.
   *
   * Idempotente: fatura já existente para o mês não é regravada, e ajustar o
   * valor para o mesmo número é inócuo. É o que permite ao webhook reprocessar
   * uma entrega que falhou no meio.
   */
  async closeInvoice(payment: AsaasPayment): Promise<InvoiceClosing | null> {
    if (payment.dueDate === undefined) {
      return null;
    }
    const tenantId = await this.tenantOf(payment);
    if (tenantId === null) {
      return null;
    }

    const referenceMonth = mesDeReferencia(payment.dueDate);
    const cotacao = await this.billing.quoteFor(tenantId, referenceMonth);
    const totalCents = cotacao.totalCents;
    const geradoCents = payment.value === undefined ? null : Math.round(payment.value * 100);

    // Carteira vazia não paga piso (ver `quote`): a cobrança do mês sai do
    // Asaas, e a fatura fica registrada como cancelada, com a cotação que
    // explica o zero.
    const removed = totalCents === 0;
    const adjusted = !removed && geradoCents !== totalCents;
    if (removed) {
      await this.gateway.deletePayment(payment.id);
    } else if (adjusted) {
      await this.gateway.updatePaymentValue(payment.id, totalCents);
      // A assinatura acompanha o último valor, para a estimativa da próxima
      // cobrança já nascer perto do certo.
      if (payment.subscription !== undefined) {
        await this.gateway.updateSubscriptionValue(payment.subscription, totalCents);
      }
    }

    const { rowCount } = await this.pool.query(
      `insert into invoices (tenant_id, reference_month, total_cents, snapshot, status, asaas_payment_id, due_date)
       values ($1::uuid, $2::char(7), $3, $4::jsonb, $7, $5, $6::date)
       on conflict (tenant_id, reference_month) do nothing`,
      [
        tenantId,
        referenceMonth,
        totalCents,
        JSON.stringify({ reference_month: referenceMonth, ...serializeQuote(cotacao) }),
        payment.id,
        payment.dueDate,
        removed ? 'canceled' : 'pending',
      ],
    );

    return { tenantId, referenceMonth, totalCents, adjusted, removed, duplicate: (rowCount ?? 0) === 0 };
  }

  /**
   * Escritório dono da cobrança. O `externalReference` da assinatura é o
   * tenant; quando a cobrança não o trouxer, a assinatura resolve.
   */
  private async tenantOf(payment: AsaasPayment): Promise<string | null> {
    if (payment.externalReference !== undefined && UUID.test(payment.externalReference)) {
      return payment.externalReference;
    }
    if (payment.subscription === undefined) {
      return null;
    }
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      'select tenant_id from subscriptions where asaas_subscription_id = $1',
      [payment.subscription],
    );
    return rows[0]?.tenant_id ?? null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
