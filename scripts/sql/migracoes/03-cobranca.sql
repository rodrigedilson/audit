-- =============================================================================
-- audit — passo 3 de 5: cobranca
--
-- Planos, assinatura e faturas. Popula os 5 planos por regime e o mínimo
-- de R$ 150. Cria billable_clients(), que define "CNPJ ativo".
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260918140000_billing.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 3 — planos, assinatura e cobrança (ADR-004: Asaas)
--
-- Cobrança fica FORA do event log fiscal, em tabelas próprias. O log fiscal é
-- trilha de defesa perante o Fisco: seu valor está em conter exatamente os
-- documentos e ajustes que produziram um número de apuração, e nada mais.
-- Misturar `payment.received` com `assessment.confirmed` poluiria o replay
-- determinístico, ampliaria o escopo de qualquer exibição do log e acoplaria a
-- integridade fiscal à disponibilidade do gateway.
-- =============================================================================

-- Preço por regime. Em tabela, não no código: o briefing é explícito em que os
-- valores são hipótese para teste de preço, e mudar preço não deve exigir deploy.
create table if not exists public.plans (
  regime         public.regime primary key,
  monthly_cents  integer not null check (monthly_cents >= 0),
  -- Vigência: mudar preço não reescreve o que já foi faturado.
  effective_from date not null default current_date,
  features       jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

comment on table public.plans is
  'Preço público por CNPJ ativo, escalonado por regime. Valores do briefing são hipótese de teste de preço.';

insert into public.plans (regime, monthly_cents, features) values
  ('mei',              900,  '["saude_cadastro","coleta_dfe","simulador_opcao"]'),
  ('simples_integrado', 900, '["saude_cadastro","coleta_dfe","simulador_opcao"]'),
  ('simples_hibrido',  2900, '["saude_cadastro","coleta_dfe","simulador_opcao","apuracao_dual","contra_apuracao","calendario"]'),
  ('lucro_presumido',  4900, '["saude_cadastro","coleta_dfe","simulador_opcao","apuracao_dual","contra_apuracao","calendario","credito_em_risco","dossie_saldo_credor","white_label"]'),
  ('lucro_real',       8900, '["saude_cadastro","coleta_dfe","simulador_opcao","apuracao_dual","contra_apuracao","calendario","credito_em_risco","dossie_saldo_credor","white_label","sped_completo"]')
on conflict (regime) do nothing;

-- Parâmetros comerciais globais, também fora do código.
create table if not exists public.billing_settings (
  id                    boolean primary key default true check (id),
  minimum_cents         integer not null default 15000 check (minimum_cents >= 0),
  trial_days            integer not null default 30 check (trial_days >= 0),
  updated_at            timestamptz not null default now()
);

insert into public.billing_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.subscriptions (
  tenant_id          uuid primary key references public.tenants (id) on delete cascade,
  status             text not null default 'trialing' check (status in (
                       'trialing', 'active', 'past_due', 'canceled'
                     )),
  -- Trial de 30 dias com XMLs reais, conforme o briefing.
  trial_ends_on      date,
  -- Identificadores no Asaas. Nulos enquanto a cobrança não foi criada.
  asaas_customer_id  text,
  asaas_subscription_id text,
  billing_day        smallint check (billing_day between 1 and 28),
  -- Cancelamento em um clique dentro do produto, sem retenção por telefone.
  canceled_at        timestamptz,
  cancel_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists subscriptions_asaas_sub_key
  on public.subscriptions (asaas_subscription_id)
  where asaas_subscription_id is not null;

-- Fatura emitida. `snapshot` guarda a cotação que a originou, para que a fatura
-- continue explicável mesmo depois de o preço da tabela mudar.
create table if not exists public.invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  reference_month   char(7) not null check (reference_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  total_cents       integer not null check (total_cents >= 0),
  snapshot          jsonb not null,
  status            text not null default 'pending' check (status in (
                      'pending', 'paid', 'overdue', 'canceled', 'refunded'
                    )),
  asaas_payment_id  text,
  due_date          date,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  unique (tenant_id, reference_month)
);

-- Log de cobrança, separado do event log fiscal. Append-only pela mesma razão:
-- histórico de cobrança também é disputável.
create table if not exists public.billing_events (
  id           bigserial primary key,
  tenant_id    uuid references public.tenants (id) on delete cascade,
  kind         text not null,
  payload      jsonb not null,
  -- Idempotência de webhook: o Asaas reentrega, e processar duas vezes um
  -- `PAYMENT_RECEIVED` marcaria a fatura como paga duas vezes.
  external_id  text,
  received_at  timestamptz not null default now()
);

create unique index if not exists billing_events_external_key
  on public.billing_events (external_id)
  where external_id is not null;

create index if not exists billing_events_tenant_idx
  on public.billing_events (tenant_id, received_at desc);

-- ----------------------------------------------------------------------- RLS
alter table public.subscriptions   enable row level security;
alter table public.invoices        enable row level security;
alter table public.billing_events  enable row level security;

-- `plans` e `billing_settings` são públicos de propósito: a calculadora de preço
-- fica no site, antes de qualquer contato comercial.
alter table public.plans            disable row level security;
alter table public.billing_settings disable row level security;

do $$
declare t text;
begin
  foreach t in array array['subscriptions', 'invoices', 'billing_events']
  loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (public.is_member_of(tenant_id))',
      t, t
    );
  end loop;
end $$;

-- =============================================================================
-- Definição de "CNPJ ativo" — a base da fatura, em SQL e não espalhada no código
--
-- Um CNPJ é faturável no mês quando está ativo **e** teve trabalho no período:
-- competência aberta ou apurada naquele mês. Cadastrar um CNPJ e não trabalhar
-- nele não gera cobrança.
-- =============================================================================
create or replace function public.billable_clients(
  p_tenant_id       uuid,
  p_reference_month char(7)
) returns table (cnpj char(14), regime public.regime)
  language sql stable as $$
  select c.cnpj, c.regime
    from public.clients c
   where c.tenant_id = p_tenant_id
     and c.status = 'active'
     and exists (
       select 1 from public.periods p
        where p.tenant_id = c.tenant_id
          and p.cnpj = c.cnpj
          and p.period = p_reference_month
     )
   order by c.cnpj;
$$;
