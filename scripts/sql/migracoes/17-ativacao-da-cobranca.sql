-- =============================================================================
-- audit — passo 17 de 32: ativacao-da-cobranca
--
-- Dados de cobrança do escritório (CPF/CNPJ, e-mail, forma de pagamento),
-- preenchidos quando o owner ativa a cobrança. Sem ativação não há
-- assinatura no Asaas: o trial acaba sem virar cobrança por omissão.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924100000_ativacao_da_cobranca.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Ativação da cobrança pelo owner
--
-- O Asaas exige CPF ou CNPJ de quem paga, e `tenants` só guarda o nome do
-- escritório. Os dados de cobrança ficam em `subscriptions`, junto dos IDs do
-- Asaas: são de cobrança, não de identidade do escritório.
--
-- Nulos até o owner ativar. Sem ativação não há cliente nem assinatura no
-- gateway, e nada é cobrado — o trial acaba sem virar cobrança por omissão.
-- =============================================================================

alter table public.subscriptions
  add column if not exists billing_document text
    check (billing_document ~ '^([0-9]{11}|[0-9]{14})$'),
  add column if not exists billing_email text
    check (billing_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add column if not exists billing_type text
    check (billing_type in ('PIX', 'BOLETO', 'CREDIT_CARD', 'UNDEFINED')),
  add column if not exists activated_at timestamptz;

comment on column public.subscriptions.billing_document is
  'CPF (11) ou CNPJ (14) do pagador, só dígitos. Enviado ao Asaas na ativação.';
comment on column public.subscriptions.activated_at is
  'Quando o owner ativou a cobrança. Nulo: trial sem cobrança configurada.';

-- O webhook acha a fatura pelo id do pagamento. Índice comum, e não único: um
-- banco com ids repetidos de antes desta migration (o de testes tem) faria o
-- `create unique index` falhar, e deduplicar fatura dentro de migration é pior
-- do que não ter a restrição. A unicidade que importa — uma fatura por mês e
-- escritório — já é a chave `(tenant_id, reference_month)`.
create index if not exists invoices_asaas_payment_idx
  on public.invoices (asaas_payment_id)
  where asaas_payment_id is not null;
