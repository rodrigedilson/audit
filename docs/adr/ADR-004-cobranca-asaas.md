# ADR-004 — Asaas como provedor de cobrança

- **Status:** Aceita
- **Data:** 2026-09-18

## Contexto

O modelo comercial do briefing é preço público por CNPJ ativo, escalonado por regime
(R$ 9 / 29 / 49 / 89), assinatura mínima R$ 150/mês, sem fidelidade, com calculadora
de preço pública e **cancelamento em um clique** — posicionamento construído
explicitamente contra as reclamações do e-Auditoria (cancelamento difícil, cobrança
indevida, 23 dias de tempo de resposta).

O público-alvo são escritórios de contabilidade brasileiros, que pagam
majoritariamente por PIX e boleto.

## Decisão

Adotar **Asaas**: PIX, boleto e cartão recorrente nativos, webhooks, API simples.

**Os eventos de cobrança NÃO entram no event log fiscal.** Ficam em tabelas
próprias, com seu próprio histórico.

## Por que separar cobrança do log fiscal

O event log fiscal é trilha de defesa perante o Fisco: seu valor está em conter
exatamente os documentos e ajustes que produziram um número de apuração, e nada
mais. Misturar `payment.received` com `assessment.confirmed` no mesmo log:

- polui o replay determinístico (uma mudança na regra de cobrança forçaria replay da
  apuração);
- amplia o escopo de qualquer auditoria ou pedido de exibição do log;
- cria acoplamento entre disponibilidade do gateway e integridade fiscal.

## Alternativas consideradas

- **Stripe:** melhor DX e *metered billing* maduro, que casaria bem com "por CNPJ
  ativo". Descartado porque PIX e boleto são limitados no Brasil e são justamente os
  meios que o público usa.
- **Cobrança manual na onda inicial:** destravaria produto mais cedo, mas não valida
  a promessa central de autosserviço e cancelamento em um clique.

## Consequências

- Precisamos de uma definição de **"CNPJ ativo"** explícita e auditável, porque ela é
  a base da fatura: CNPJ com `status = ativo` **e** pelo menos uma competência aberta
  ou apurada no mês de referência.
- O piso de R$ 150 é aplicado no cálculo da fatura, não no catálogo de planos.
- Os valores são hipótese de teste de preço e ficam em tabela, nunca hardcoded.
