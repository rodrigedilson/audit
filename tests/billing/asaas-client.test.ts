import { describe, it, expect } from 'vitest';
import { AsaasClient, AsaasError, type FetchLike } from '../../src/billing/asaas-client.js';

interface Chamada {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** `fetch` dublado: grava a requisição e devolve a resposta dada. */
function cliente(status = 200, resposta: unknown = {}): { asaas: AsaasClient; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    chamadas.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return new Response(JSON.stringify(resposta), { status });
  };
  return {
    asaas: new AsaasClient({ apiKey: 'chave', baseUrl: 'https://api-sandbox.asaas.com/v3', fetchImpl }),
    chamadas,
  };
}

describe('AsaasClient', () => {
  it('manda a chave no cabeçalho access_token', async () => {
    const { asaas, chamadas } = cliente(200, { id: 'cus_1' });
    await asaas.createCustomer({ name: 'Escritório', cpfCnpj: '11222333000181' });

    expect(chamadas[0]!.headers['access_token']).toBe('chave');
  });

  /** O produto guarda centavos; o Asaas trabalha em reais. */
  it('a assinatura vai em reais, mensal, com o tenant como referência', async () => {
    const { asaas, chamadas } = cliente(200, { id: 'sub_1' });
    const id = await asaas.createSubscription({
      customerId: 'cus_1',
      valueCents: 15_000,
      nextDueDate: '2026-12-10',
      billingType: 'PIX',
      description: 'assinatura',
      externalReference: 'tenant-1',
    });

    expect(id).toBe('sub_1');
    expect(chamadas[0]).toMatchObject({
      url: 'https://api-sandbox.asaas.com/v3/subscriptions',
      method: 'POST',
      body: { customer: 'cus_1', value: 150, cycle: 'MONTHLY', nextDueDate: '2026-12-10', externalReference: 'tenant-1' },
    });
  });

  it('fecha o valor da cobrança do mês', async () => {
    const { asaas, chamadas } = cliente();
    await asaas.updatePaymentValue('pay_1', 5_800);

    expect(chamadas[0]).toMatchObject({
      url: 'https://api-sandbox.asaas.com/v3/payments/pay_1',
      method: 'POST',
      body: { value: 58 },
    });
  });

  it('remove a cobrança de um mês sem CNPJ ativo', async () => {
    const { asaas, chamadas } = cliente();
    await asaas.deletePayment('pay_1');

    expect(chamadas[0]).toMatchObject({
      url: 'https://api-sandbox.asaas.com/v3/payments/pay_1',
      method: 'DELETE',
    });
  });

  it('erro do Asaas traz a descrição que o gateway deu', async () => {
    const { asaas } = cliente(400, { errors: [{ code: 'invalid_cpfCnpj', description: 'CPF/CNPJ inválido' }] });

    const erro = await asaas.createCustomer({ name: 'x', cpfCnpj: '1' }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(AsaasError);
    expect((erro as AsaasError).status).toBe(400);
    expect((erro as AsaasError).message).toBe('Asaas recusou a operação: CPF/CNPJ inválido');
  });

  it('resposta sem id é erro, e não um cliente vazio', async () => {
    const { asaas } = cliente(200, {});

    await expect(asaas.createCustomer({ name: 'x', cpfCnpj: '1' })).rejects.toThrow(/não devolveu id/);
  });
});
