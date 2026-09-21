/**
 * Cliente do Asaas (ADR-004). Só o que a Onda 3 usa: cliente, assinatura e
 * cancelamento.
 *
 * `fetchImpl` é injetável para que os testes exercitem o tratamento de resposta
 * sem rede — e para que um erro de contrato do gateway apareça em teste, não em
 * produção.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AsaasConfig {
  apiKey: string;
  /** Sandbox: https://api-sandbox.asaas.com/v3 */
  baseUrl: string;
  fetchImpl?: FetchLike;
}

export type BillingType = 'PIX' | 'BOLETO' | 'CREDIT_CARD' | 'UNDEFINED';

export interface AsaasCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string;
}

export interface AsaasSubscriptionInput {
  customerId: string;
  valueCents: number;
  nextDueDate: string;
  billingType: BillingType;
  description: string;
  externalReference: string;
}

export class AsaasError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AsaasError';
  }
}

export class AsaasClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: AsaasConfig) {
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async createCustomer(input: AsaasCustomerInput): Promise<string> {
    const body = await this.request<{ id?: string }>('POST', '/customers', {
      name: input.name,
      cpfCnpj: input.cpfCnpj,
      ...(input.email === undefined ? {} : { email: input.email }),
    });

    if (!body.id) {
      throw new AsaasError('Asaas não devolveu id do cliente.', 502);
    }
    return body.id;
  }

  async createSubscription(input: AsaasSubscriptionInput): Promise<string> {
    const body = await this.request<{ id?: string }>('POST', '/subscriptions', {
      customer: input.customerId,
      billingType: input.billingType,
      // O Asaas trabalha em reais com decimal; o produto guarda centavos para
      // não acumular erro de ponto flutuante na soma da carteira.
      value: input.valueCents / 100,
      nextDueDate: input.nextDueDate,
      cycle: 'MONTHLY',
      description: input.description,
      externalReference: input.externalReference,
    });

    if (!body.id) {
      throw new AsaasError('Asaas não devolveu id da assinatura.', 502);
    }
    return body.id;
  }

  /** Atualiza o valor quando a carteira muda de tamanho. */
  async updateSubscriptionValue(subscriptionId: string, valueCents: number): Promise<void> {
    await this.request('POST', `/subscriptions/${subscriptionId}`, {
      value: valueCents / 100,
    });
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.request('DELETE', `/subscriptions/${subscriptionId}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        access_token: this.config.apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new AsaasError(describeAsaasError(parsed, response.status), response.status);
    }

    return parsed as T;
  }
}

/**
 * O Asaas devolve `errors: [{ code, description }]`. Extrair a descrição evita
 * que o operador veja "erro 400" e tenha de abrir o painel do gateway.
 */
function describeAsaasError(parsed: unknown, status: number): string {
  const errors = (parsed as { errors?: { description?: string }[] }).errors;
  const description = errors?.map((error) => error.description).filter(Boolean).join('; ');

  return description && description.length > 0
    ? `Asaas recusou a operação: ${description}`
    : `Asaas respondeu ${status}.`;
}
