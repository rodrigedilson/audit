-- =============================================================================
-- audit — setup completo do Supabase
--
-- ARQUIVO GERADO. Não edite aqui: altere as migrations em supabase/migrations/
-- e rode `npm run sql:bundle`. Editar este arquivo faria o banco divergir do
-- que a suíte de testes exercita.
--
-- COMO USAR
--   1. Crie seu usuário antes: Authentication → Users → Add user,
--      marcando "Auto Confirm User". Este projeto está com mailer_autoconfirm
--      desligado, então um cadastro comum fica pendente e o login falha.
--   2. Edite as duas linhas marcadas com CONFIGURE, lá embaixo na PARTE 2.
--   3. Cole o arquivo inteiro no SQL Editor e execute.
--
-- É IDEMPOTENTE: pode rodar de novo sem duplicar nada. Objetos usam
-- `if not exists`, e o bootstrap não cria um segundo escritório para quem já
-- tem um.
--
-- O QUE CRIA no schema public:
--   tabelas  tenants, memberships, clients, periods, events,
--            projection_snapshots, jobs, certificates, plans,
--            billing_settings, subscriptions, invoices, billing_events,
--            documents, document_items
--   funções  current_user_id, is_member_of, append_event, billable_clients,
--            events_reject_mutation
--   RLS      ligado em todas as tabelas com tenant_id, apenas policies de
--            SELECT. Sem policy de escrita, todo write vindo do cliente é
--            negado; a API escreve com a service role. O RLS aqui é a segunda
--            tranca: toda escrita fiscal passa pelo pipeline de 7 camadas, e um
--            INSERT direto burlaria isso.
-- =============================================================================

-- =============================================================================
-- PARTE 1 — migrations (7 arquivos, na ordem de aplicação)
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260918120000_multi_tenancy.sql
-- ─────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Onda 1 — Multi-tenancy: escritório (tenant) → usuários → CNPJs → competências
--
-- Ver ADR-001 (Supabase), ADR-002 (isolamento) e ADR-003 (event store).
--
-- Regra que atravessa este arquivo: o RLS aqui é a SEGUNDA tranca, não a
-- primeira. Toda escrita fiscal passa pela API, que é single-writer e roda o
-- pipeline de 7 camadas; um INSERT direto do cliente burlaria as duas coisas e
-- produziria log sem trilha de validação. O RLS existe para o caso de uma chave
-- anon vazar.
-- =============================================================================

-- `gen_random_uuid()` é do core desde o PostgreSQL 13, então não precisamos da
-- extensão pgcrypto. Evitar o `create extension` também evita conflito com a
-- cópia que o Supabase já instala no schema `extensions`.

-- ------------------------------------------------------------------ tenants
create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  plan        text not null default 'trial',
  created_at  timestamptz not null default now()
);

comment on table public.tenants is 'Escritório de contabilidade. Unidade de cobrança e de isolamento.';

-- -------------------------------------------------------------- memberships
do $$ begin
  create type public.membership_role as enum ('owner', 'accountant', 'viewer');
exception when duplicate_object then null; end $$;

create table if not exists public.memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  -- Referencia auth.users do Supabase. Sem FK declarada de propósito: mantém as
  -- migrations aplicáveis num Postgres puro (CI, dev local), onde o schema auth
  -- não existe.
  user_id     uuid not null,
  role        public.membership_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists memberships_user_idx on public.memberships (user_id);

-- ------------------------------------------------------------------ clients
do $$ begin
  create type public.regime as enum (
    'mei', 'simples_integrado', 'simples_hibrido', 'lucro_presumido', 'lucro_real'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.clients (
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  cnpj               char(14) not null check (cnpj ~ '^[0-9]{14}$'),
  legal_name         text not null check (length(btrim(legal_name)) > 0),
  trade_name         text,
  regime             public.regime not null,
  uf                 char(2),
  municipality_ibge  char(7) check (municipality_ibge is null or municipality_ibge ~ '^[0-9]{7}$'),
  cnae_primary       text,
  -- Base da cobrança por CNPJ ativo (ADR-004). Um CNPJ inativo continua no banco
  -- com todo o histórico: o event log é trilha fiscal e não se apaga porque o
  -- cliente saiu.
  status             text not null default 'active' check (status in ('active', 'inactive')),
  created_at         timestamptz not null default now(),
  primary key (tenant_id, cnpj)
);

-- ------------------------------------------------------------------ periods
do $$ begin
  create type public.period_state as enum ('open', 'assessed', 'reconciled', 'confirmed');
exception when duplicate_object then null; end $$;

create table if not exists public.periods (
  tenant_id        uuid not null,
  cnpj             char(14) not null,
  period           char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  state            public.period_state not null default 'open',
  projection_hash  text,
  confirmed_at     timestamptz,
  confirmed_by     uuid,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, cnpj, period),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade,
  -- INV-001: confirmed é terminal. Um período confirmado sem hash nem carimbo de
  -- quem confirmou seria uma trilha inútil justamente no estado que importa.
  constraint periods_confirmed_requires_trail check (
    state <> 'confirmed' or (projection_hash is not null and confirmed_at is not null)
  )
);

-- ------------------------------------------------------------------- events
create table if not exists public.events (
  tenant_id       uuid not null,
  cnpj            char(14) not null check (cnpj ~ '^[0-9]{14}$'),
  -- Monotônico e sem gaps DENTRO do par (tenant_id, cnpj), nunca global.
  event_seq       bigint not null check (event_seq >= 0),
  event_id        uuid not null,
  action          text not null,
  task_id         text not null,
  actor           text not null,
  period          char(7) check (period is null or period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ts              timestamptz not null,
  schema_version  text not null,
  payload         jsonb not null,
  primary key (tenant_id, cnpj, event_seq)
);

-- INV-004 tem duas metades. A sequência sem gaps é garantida pela PK acima mais
-- a alocação sob advisory lock; a unicidade de event_id é esta constraint, que
-- nunca existiu em lugar algum — era invariante declarada e nunca verificada.
create unique index if not exists events_event_id_key on public.events (event_id);

create index if not exists events_scope_ts_idx on public.events (tenant_id, cnpj, ts desc);
create index if not exists events_scope_action_idx on public.events (tenant_id, cnpj, action);
create index if not exists events_scope_period_idx on public.events (tenant_id, cnpj, period)
  where period is not null;

comment on table public.events is
  'Event log append-only. Sem UPDATE nem DELETE: ver trigger events_append_only.';

-- O log é append-only e isso precisa ser garantido pelo banco, não por
-- convenção. Sem isto, um UPDATE numa linha de evento reescreveria a história e
-- o replay passaria a "provar" o número adulterado.
create or replace function public.events_reject_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception 'events é append-only: % não é permitido (INV-001/INV-006)', tg_op;
end $$;

drop trigger if exists events_append_only on public.events;
create trigger events_append_only
  before update or delete on public.events
  for each row execute function public.events_reject_mutation();

-- ------------------------------------------------------ projection_snapshots
-- Elimina o replay integral a cada intenção. O snapshot pode divergir do log,
-- então guarda last_event_seq e o hash: POST /verify sempre reprojeta do zero.
create table if not exists public.projection_snapshots (
  tenant_id        uuid not null,
  cnpj             char(14) not null,
  last_event_seq   bigint not null,
  projection       jsonb not null,
  projection_hash  text not null,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, cnpj)
);

-- --------------------------------------------------------------------- jobs
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  cnpj        char(14),
  kind        text not null check (kind in (
                'dfe_sync', 'sped_import', 'bank_statement_import', 'book_generation'
              )),
  status      text not null default 'queued' check (status in (
                'queued', 'running', 'done', 'failed'
              )),
  progress    smallint not null default 0 check (progress between 0 and 100),
  accepted    integer not null default 0,
  rejected    integer not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists jobs_scope_idx on public.jobs (tenant_id, cnpj, created_at desc);

-- =============================================================================
-- Alocação de event_seq sob lock por CNPJ — INV-005
--
-- O single-writer não existia: havia apenas a string 'lock_violation' num enum,
-- sem produtor. E a alocação era um read-modify-write em JavaScript
-- (getLastSeq + 1 + append), sem atomicidade.
--
-- O lock é por (tenant, cnpj) e NÃO global: dois CNPJs do mesmo escritório
-- precisam poder fechar em paralelo. `pg_advisory_xact_lock` é liberado no fim
-- da transação, sem risco de lock órfão se a aplicação cair.
-- =============================================================================
create or replace function public.append_event(
  p_tenant_id       uuid,
  p_cnpj            char(14),
  p_event_id        uuid,
  p_action          text,
  p_task_id         text,
  p_actor           text,
  p_period          char(7),
  p_ts              timestamptz,
  p_schema_version  text,
  p_payload         jsonb
) returns bigint
  language plpgsql as $$
declare
  v_seq bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_cnpj, 0));

  select coalesce(max(event_seq) + 1, 0) into v_seq
    from public.events
   where tenant_id = p_tenant_id and cnpj = p_cnpj;

  insert into public.events (
    tenant_id, cnpj, event_seq, event_id, action, task_id, actor,
    period, ts, schema_version, payload
  ) values (
    p_tenant_id, p_cnpj, v_seq, p_event_id, p_action, p_task_id, p_actor,
    p_period, p_ts, p_schema_version, p_payload
  );

  return v_seq;
end $$;

-- =============================================================================
-- RLS — segunda tranca
-- =============================================================================
/**
 * Id do usuário autenticado.
 *
 * No Supabase a resposta é `auth.uid()`. Num Postgres puro (CI, desenvolvimento
 * local, testes) o schema `auth` não existe, e aí caímos na GUC que o PostgREST
 * define. O `exception` cobre os dois casos sem exigir duas versões da
 * migration — e sem exigir que alguém lembre de editar o arquivo antes de colar
 * no editor do Supabase.
 */
create or replace function public.current_user_id() returns uuid
  language plpgsql stable as $$
begin
  return (select auth.uid());
exception
  when undefined_function or invalid_schema_name or undefined_table then
    return nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
end $$;

create or replace function public.is_member_of(p_tenant_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
     where tenant_id = p_tenant_id
       and user_id = public.current_user_id()
  );
$$;

alter table public.tenants              enable row level security;
alter table public.memberships          enable row level security;
alter table public.clients              enable row level security;
alter table public.periods              enable row level security;
alter table public.events               enable row level security;
alter table public.projection_snapshots enable row level security;
alter table public.jobs                 enable row level security;

do $$
declare
  t text;
begin
  -- Leitura restrita à própria carteira. Nenhuma policy de INSERT/UPDATE/DELETE
  -- é criada de propósito: com RLS ligado e sem policy de escrita, todo write do
  -- cliente é negado. A API escreve com a service role, que ignora RLS.
  foreach t in array array['clients', 'periods', 'events', 'projection_snapshots', 'jobs']
  loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (public.is_member_of(tenant_id))',
      t, t
    );
  end loop;
end $$;

drop policy if exists tenants_select_own on public.tenants;
create policy tenants_select_own on public.tenants
  for select using (public.is_member_of(id));

drop policy if exists memberships_select_own on public.memberships;
create policy memberships_select_own on public.memberships
  for select using (public.is_member_of(tenant_id));


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260918130000_certificate_vault.sql
-- ─────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Onda 2 — cofre de certificados A1 (diferencial #4 do roadmap)
--
-- O PFX permite agir em nome do contribuinte perante o Fisco. Fica cifrado com
-- AES-256-GCM pela aplicação (chave mestra fora do banco) e nunca é devolvido
-- pela API: só metadados. Todo uso vira evento `certificate.used` no event log,
-- o que dá trilha de acesso sem precisar de mecanismo separado.
-- =============================================================================

create table if not exists public.certificates (
  tenant_id     uuid not null,
  cnpj          char(14) not null check (cnpj ~ '^[0-9]{14}$'),

  -- `iv:authTag:ciphertext` em base64. Cifragem é da aplicação, não do banco:
  -- pgcrypto deixaria a chave no servidor de banco, junto do dado que ela
  -- protege.
  encrypted_pfx text not null,
  -- SHA-256 do PFX em claro. Detecta troca silenciosa do arquivo por quem tenha
  -- acesso de escrita à tabela.
  fingerprint   char(64) not null,

  subject       text not null,
  issuer        text not null,
  serial        text not null,
  valid_from    timestamptz not null,
  valid_to      timestamptz not null,
  stored_at     timestamptz not null default now(),
  stored_by     uuid not null,

  primary key (tenant_id, cnpj),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade,
  constraint certificates_validity_order check (valid_to > valid_from)
);

-- Alimenta `GET /certificates/expiring`, que é o alerta que evita a coleta de
-- DF-e parar sem ninguém perceber.
create index if not exists certificates_expiry_idx on public.certificates (tenant_id, valid_to);

alter table public.certificates enable row level security;

-- Somente leitura de metadados, e nem isso inclui o PFX: a coluna
-- `encrypted_pfx` nunca é selecionada pela API. Sem policy de escrita, todo
-- write do cliente é negado; a API escreve com a service role.
drop policy if exists certificates_select_own on public.certificates;
create policy certificates_select_own on public.certificates
  for select using (public.is_member_of(tenant_id));


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260918140000_billing.sql
-- ─────────────────────────────────────────────────────────────────────────

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


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260918150000_ingestion.sql
-- ─────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Onda 4 — ingestão de documentos fiscais
--
-- `documents` e `document_items` são read model: a verdade é o event log
-- (`doc.received`). Existem porque a carteira precisa listar e filtrar milhares
-- de notas, e porque guardar a chave de acesso de cada documento dentro da
-- projeção hasheada inflaria o hash sem acrescentar garantia.
-- =============================================================================

create table if not exists public.documents (
  tenant_id          uuid not null,
  cnpj               char(14) not null check (cnpj ~ '^[0-9]{14}$'),
  access_key         char(44) not null check (access_key ~ '^[0-9]{44}$'),

  model              text not null check (model in ('nfe', 'nfce', 'nfse', 'cte')),
  -- Relativo ao CNPJ do escopo: saída quando ele é o emitente.
  direction          text not null check (direction in ('inbound', 'outbound')),
  series             text,
  number             text,
  issued_at          timestamptz not null,
  period             char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  issuer_cnpj        char(14) not null,
  issuer_name        text,
  counterparty_cnpj  char(14),
  counterparty_name  text,

  total_cents        bigint not null default 0,
  -- Marca se o documento já traz o grupo UB (IBS/CBS). Alimenta o indicador de
  -- prontidão da carteira para a reforma.
  has_reform_group   boolean not null default false,

  event_seq          bigint not null,
  received_at        timestamptz not null default now(),

  -- Chave de acesso é única por documento no país. A constraint é o que torna
  -- `duplicate_document` uma garantia e não uma checagem best-effort.
  primary key (tenant_id, cnpj, access_key),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists documents_period_idx
  on public.documents (tenant_id, cnpj, period, issued_at desc);
create index if not exists documents_direction_idx
  on public.documents (tenant_id, cnpj, direction);
create index if not exists documents_counterparty_idx
  on public.documents (tenant_id, cnpj, counterparty_cnpj)
  where counterparty_cnpj is not null;

create table if not exists public.document_items (
  tenant_id       uuid not null,
  cnpj            char(14) not null,
  access_key      char(44) not null,
  line            integer not null,

  code            text,
  description     text,
  ncm             text,
  cfop            text,
  unit            text,
  quantity        numeric(15, 4) not null default 0,
  unit_price_cents bigint not null default 0,
  total_cents     bigint not null default 0,

  -- Tributos atuais e grupo UB lado a lado, como saíram do documento. É a base
  -- da apuração dual da Onda 6.
  legacy_taxes    jsonb not null default '{}'::jsonb,
  reform_taxes    jsonb,

  primary key (tenant_id, cnpj, access_key, line),
  foreign key (tenant_id, cnpj, access_key)
    references public.documents (tenant_id, cnpj, access_key) on delete cascade
);

create index if not exists document_items_ncm_idx
  on public.document_items (tenant_id, cnpj, ncm);

alter table public.documents      enable row level security;
alter table public.document_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array['documents', 'document_items']
  loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (public.is_member_of(tenant_id))',
      t, t
    );
  end loop;
end $$;


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260921120000_catalog.sql
-- ─────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Onda 5 — catálogo de itens e saúde do cadastro (diferencial #1)
--
-- A tese: o erro nasce no cadastro do item e contamina toda a cadeia. Um NCM ou
-- cClassTrib errado no cadastro vira erro em toda nota emitida com aquele item,
-- e os verificadores gratuitos não pegam isso porque olham um XML por vez.
--
-- Por isso o valor está na PROPAGAÇÃO: quantas notas já emitidas cada item
-- errado contaminou.
-- =============================================================================

-- ----------------------------------------------------- tabelas de referência
--
-- Códigos oficiais. Uma tabela VAZIA significa "não validado", e é reportado
-- como tal — nunca como "ok". Validar contra tabela vazia daria aprovação a
-- qualquer código, que é pior do que não validar.
create table if not exists public.fiscal_codes (
  kind        text not null check (kind in (
                'ncm', 'nbs', 'cfop', 'cst_icms', 'cst_pis_cofins',
                'cst_ibs_cbs', 'cclasstrib'
              )),
  code        text not null,
  description text,
  -- Vigência: código revogado não invalida classificação feita quando valia.
  valid_from  date not null default '2026-01-01',
  valid_to    date,
  source      text,
  primary key (kind, code, valid_from)
);

comment on table public.fiscal_codes is
  'Códigos oficiais (IT RT 2025.002 e tabelas da RFB). Tabela vazia = não validado, nunca "ok".';

create index if not exists fiscal_codes_kind_idx on public.fiscal_codes (kind, code);

-- Pareamento cClassTrib × CST-IBS/CBS.
--
-- Pares EXPLÍCITOS, não uma regra derivada de prefixo: a estrutura da tabela
-- oficial sugere a correspondência, mas codificar a inferência transformaria uma
-- suposição minha em regra fiscal. Carregar a tabela oficial é tarefa de dado,
-- não mudança de código.
create table if not exists public.cclasstrib_cst (
  cclasstrib  text not null,
  cst_ibs_cbs text not null,
  description text,
  primary key (cclasstrib, cst_ibs_cbs)
);

comment on table public.cclasstrib_cst is
  'Pares válidos de cClassTrib e CST-IBS/CBS. Vazia = incompatibilidade não verificável.';

-- Monofásico e ST por NCM. Segregar isso é o que evita cobrar duas vezes o que
-- já foi tributado na origem.
create table if not exists public.ncm_flags (
  ncm                     char(8) not null check (ncm ~ '^[0-9]{8}$'),
  monophasic              boolean not null default false,
  tax_substitution        boolean not null default false,
  note                    text,
  valid_from              date not null default '2026-01-01',
  primary key (ncm, valid_from)
);

-- ----------------------------------------------------------------- catálogo
create table if not exists public.items (
  tenant_id    uuid not null,
  cnpj         char(14) not null check (cnpj ~ '^[0-9]{14}$'),
  item_id      text not null,
  description  text,
  -- Última vez que o item apareceu num documento. Item que não aparece há
  -- meses não merece a mesma atenção de um que está em uso.
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, cnpj, item_id),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

-- Classificação versionada por vigência.
--
-- Reclassificar NÃO reescreve o passado: insere uma linha nova com
-- `effective_from` posterior. É o que permite ao escritório mostrar qual
-- classificação valia quando cada nota foi emitida.
create table if not exists public.item_classifications (
  tenant_id       uuid not null,
  cnpj            char(14) not null,
  item_id         text not null,
  effective_from  char(7) not null check (effective_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  ncm             char(8) check (ncm ~ '^[0-9]{8}$'),
  nbs             text,
  cst_ibs_cbs     text,
  cclasstrib      text,
  cst_icms        text,
  cst_pis_cofins  text,
  cfop_default    text,
  justification   text,

  -- Resultado da validação no momento da classificação, para a tela de saúde
  -- não recalcular tudo a cada carga.
  health          text not null default 'ok' check (health in ('ok', 'warning', 'error')),
  health_reasons  jsonb not null default '[]'::jsonb,

  event_seq       bigint not null,
  classified_by   uuid,
  classified_at   timestamptz not null default now(),

  primary key (tenant_id, cnpj, item_id, effective_from),
  foreign key (tenant_id, cnpj, item_id)
    references public.items (tenant_id, cnpj, item_id) on delete cascade
);

create index if not exists item_classifications_health_idx
  on public.item_classifications (tenant_id, cnpj, health);

alter table public.items                enable row level security;
alter table public.item_classifications enable row level security;

-- Tabelas de referência são públicas: são dados oficiais, não do cliente.
alter table public.fiscal_codes    disable row level security;
alter table public.cclasstrib_cst  disable row level security;
alter table public.ncm_flags       disable row level security;

do $$
declare t text;
begin
  foreach t in array array['items', 'item_classifications']
  loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (public.is_member_of(tenant_id))',
      t, t
    );
  end loop;
end $$;

-- =============================================================================
-- Classificação vigente de um item numa competência
--
-- "Vigente" é a classificação de maior `effective_from` que não passa da
-- competência consultada. Sem isso, a apuração de janeiro usaria a
-- reclassificação feita em março.
-- =============================================================================
create or replace function public.effective_classification(
  p_tenant_id uuid,
  p_cnpj      char(14),
  p_item_id   text,
  p_period    char(7)
) returns setof public.item_classifications
  language sql stable as $$
  select *
    from public.item_classifications
   where tenant_id = p_tenant_id
     and cnpj = p_cnpj
     and item_id = p_item_id
     and effective_from <= p_period
   order by effective_from desc
   limit 1;
$$;

-- =============================================================================
-- Propagação: quantas notas emitidas cada item contaminou
--
-- É o diferencial. Um verificador que olha um XML por vez nunca responde isso,
-- porque a pergunta é sobre o cadastro, não sobre o documento.
-- =============================================================================
create or replace function public.item_propagation(
  p_tenant_id uuid,
  p_cnpj      char(14)
) returns table (
  item_id                      text,
  health                       text,
  outbound_documents_affected  bigint,
  inbound_documents_affected   bigint,
  total_cents_affected         bigint
) language sql stable as $$
  with vigente as (
    select distinct on (c.item_id) c.item_id, c.health
      from public.item_classifications c
     where c.tenant_id = p_tenant_id and c.cnpj = p_cnpj
     order by c.item_id, c.effective_from desc
  )
  select v.item_id,
         v.health,
         count(*) filter (where d.direction = 'outbound') as outbound_documents_affected,
         count(*) filter (where d.direction = 'inbound')  as inbound_documents_affected,
         coalesce(sum(di.total_cents), 0)                 as total_cents_affected
    from vigente v
    left join public.document_items di
      on di.tenant_id = p_tenant_id and di.cnpj = p_cnpj and di.code = v.item_id
    left join public.documents d
      on d.tenant_id = di.tenant_id and d.cnpj = di.cnpj and d.access_key = di.access_key
   group by v.item_id, v.health;
$$;


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260921130000_assessment.sql
-- ─────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Onda 6 — motor de regras e apuração dual (diferencial #2)
--
-- Débito e crédito potencial saem dos valores destacados nos próprios
-- documentos: são a soma do que o emitente declarou, e não dependem de alíquota
-- nenhuma. É a "Base Espelho" — 100% dos documentos, zero amostragem.
--
-- O valor DEVIDO é outra coisa: decidir se um crédito é aproveitável depende do
-- regime e da norma vigente. Sem regra publicada, este sistema devolve `null`
-- com o motivo, e não um número plausível. Um número fiscal errado é pior do
-- que um ausente: o ausente o contador investiga, o errado ele entrega.
-- =============================================================================

-- ------------------------------------------------------------- motor de regras
--
-- Vazia por padrão, de propósito. As alíquotas de referência que o briefing cita
-- (Res. CGIBS 14/2026) estão marcadas como "não conferidas em texto oficial", e
-- semear um valor não conferido faria o produto entregar número errado com cara
-- de número certo.
create table if not exists public.tax_rules (
  id           uuid primary key default gen_random_uuid(),

  kind         text not null check (kind in ('credit_share', 'rate', 'reduction')),
  -- Nulo = vale para todos os regimes.
  regime       public.regime,
  tax          text not null check (tax in (
                 'icms', 'ipi', 'pis', 'cofins', 'ibs_uf', 'ibs_mun', 'cbs'
               )),

  -- Para `credit_share`, fração de 0 a 1 do crédito destacado que é aproveitável.
  value        numeric(10, 6) not null check (value >= 0),

  -- Vigência por data: mudar regra não reescreve apuração já fechada, e o
  -- replay determinístico (INV-006) reprocessa a carteira quando uma regra
  -- entra em vigor.
  valid_from   date not null,
  valid_to     date,

  -- Rastro normativo. Sem fonte, a regra não deveria estar aqui.
  source       text not null,
  published_by uuid,
  published_at timestamptz not null default now(),

  constraint tax_rules_validity_order check (valid_to is null or valid_to >= valid_from)
);

comment on table public.tax_rules is
  'Regras com vigência por data. Vazia = valor devido não determinável, nunca assumido.';

-- Uma regra vigente por (kind, regime, tax) em cada data.
--
-- Dois índices parciais em vez de um com `coalesce(regime::text, '*')`: o cast
-- de enum para text é STABLE, não IMMUTABLE, e o Postgres recusa expressão não
-- imutável em índice.
create unique index if not exists tax_rules_vigencia_regime_key
  on public.tax_rules (kind, regime, tax, valid_from)
  where regime is not null;

create unique index if not exists tax_rules_vigencia_geral_key
  on public.tax_rules (kind, tax, valid_from)
  where regime is null;

create index if not exists tax_rules_lookup_idx
  on public.tax_rules (kind, tax, valid_from desc);

-- --------------------------------------------------------------- apuração
create table if not exists public.assessments (
  tenant_id        uuid not null,
  cnpj             char(14) not null,
  period           char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  regime           public.regime not null,
  -- Totais por tributo, com debits/potential_credits/creditable/due. `due` nulo
  -- quando a regra não está publicada.
  totals           jsonb not null,
  not_computable   jsonb not null default '[]'::jsonb,
  coverage         jsonb not null default '{}'::jsonb,

  documents_count  integer not null default 0,
  items_count      integer not null default 0,

  -- Hash da projeção do CNPJ no instante da apuração. É o que o `confirm`
  -- compara com o que o usuário viu na tela.
  projection_hash  text not null,
  event_seq        bigint not null,
  computed_at      timestamptz not null default now(),

  primary key (tenant_id, cnpj, period),
  foreign key (tenant_id, cnpj, period)
    references public.periods (tenant_id, cnpj, period) on delete cascade
);

-- Memória de cálculo: uma linha por item e por tributo. É o que dá ao contador
-- o que defender, nota a nota.
create table if not exists public.assessment_lines (
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  period        char(7) not null,

  access_key    char(44) not null,
  line          integer not null,
  tax           text not null,

  item_code     text,
  ncm           text,
  direction     text not null check (direction in ('inbound', 'outbound')),
  cst           text,
  base_cents    bigint not null default 0,
  rate          numeric(10, 4) not null default 0,
  amount_cents  bigint not null default 0,
  origin        text not null default 'documento',

  primary key (tenant_id, cnpj, period, access_key, line, tax),
  foreign key (tenant_id, cnpj, period)
    references public.assessments (tenant_id, cnpj, period) on delete cascade
);

create index if not exists assessment_lines_tax_idx
  on public.assessment_lines (tenant_id, cnpj, period, tax);

-- Ajuste manual justificado. Nunca sobrescreve a apuração: entra como linha
-- própria, para a diferença entre o apurado e o ajustado ficar visível.
create table if not exists public.assessment_adjustments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  cnpj         char(14) not null,
  period       char(7) not null,

  tax          text not null,
  amount_cents bigint not null,
  reason       text not null check (length(btrim(reason)) > 0),
  reference_access_key char(44),

  event_seq    bigint not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),

  foreign key (tenant_id, cnpj, period)
    references public.assessments (tenant_id, cnpj, period) on delete cascade
);

create index if not exists assessment_adjustments_scope_idx
  on public.assessment_adjustments (tenant_id, cnpj, period);

alter table public.assessments            enable row level security;
alter table public.assessment_lines       enable row level security;
alter table public.assessment_adjustments enable row level security;

-- `tax_rules` é dado normativo, não do cliente: leitura pública, como as
-- tabelas de códigos.
alter table public.tax_rules disable row level security;

do $$
declare t text;
begin
  foreach t in array array['assessments', 'assessment_lines', 'assessment_adjustments']
  loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (public.is_member_of(tenant_id))',
      t, t
    );
  end loop;
end $$;

do $$
begin
  grant select on public.tax_rules to anon, authenticated;
exception when undefined_object then
  -- Postgres sem os papéis do Supabase (CI, dev local).
  null;
end $$;

-- =============================================================================
-- Regras vigentes numa data
--
-- A mais recente cujo `valid_from` não passa da data e cujo `valid_to` não
-- expirou. Regime específico tem precedência sobre a regra geral.
-- =============================================================================
create or replace function public.effective_rules(
  p_regime public.regime,
  p_date   date
) returns table (kind text, tax text, value numeric, rule_id uuid, source text)
  language sql stable as $$
  select distinct on (r.kind, r.tax)
         r.kind, r.tax, r.value, r.id as rule_id, r.source
    from public.tax_rules r
   where r.valid_from <= p_date
     and (r.valid_to is null or r.valid_to >= p_date)
     and (r.regime is null or r.regime = p_regime)
   order by r.kind, r.tax,
            -- Regime específico ganha da regra geral; entre iguais, a mais recente.
            (r.regime is not null) desc,
            r.valid_from desc;
$$;


-- ─────────────────────────────────────────────────────────────────────────
-- supabase/migrations/20260921140000_reporting.sql
-- ─────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Onda 7 — trilhas de auditoria e Book de fechamento (diferencial #3)
--
-- É o primeiro entregável que o escritório manda ao cliente final: tangibiliza
-- a saúde do cadastro e a apuração dual num documento assinado pelo hash.
--
-- NOTA DE HONESTIDADE SOBRE AS TRILHAS
-- O briefing cita o "Book de Auditorias (15+ verificações que a RFB faz)" do
-- concorrente como algo a copiar. As trilhas semeadas aqui NÃO são uma lista de
-- verificações da RFB: são exatamente as checagens que ESTE sistema executa,
-- cada uma amarrada a uma camada do pipeline e a um motivo de rejeição que
-- existe no código. Nomear uma trilha que o produto não verifica seria vender
-- conferência que não acontece.
-- =============================================================================

create table if not exists public.audit_trails (
  trail_id         text primary key,
  name             text not null,
  description      text not null,

  -- Camada do pipeline que detecta (1 parse … 7 verification-gate). Nula quando
  -- a trilha não nasce do pipeline, e sim do ciclo da competência.
  layer            smallint check (layer between 1 and 7),
  default_severity text not null check (default_severity in ('low','medium','high','critical')),
  tax_scope        text not null check (tax_scope in ('legacy','reform','both','none')),

  -- Nulo = vale para todos os regimes.
  applies_to_regimes public.regime[],

  -- Origem do dado que alimenta a trilha, para o Book explicar de onde vem.
  source           text not null check (source in (
                     'output_rejected', 'item_classification', 'assessment', 'period_state'
                   )),
  -- Chave que liga a trilha ao motivo registrado na origem.
  matches          text[] not null default '{}',
  active           boolean not null default true
);

comment on table public.audit_trails is
  'Catálogo de trilhas. Cada uma corresponde a uma checagem que o sistema executa de fato.';

insert into public.audit_trails
  (trail_id, name, description, layer, default_severity, tax_scope, source, matches) values

  ('xml_malformado',
   'XML malformado',
   'Arquivo recusado na leitura: não é XML válido. Documento não entrou na apuração.',
   1, 'critical', 'none', 'output_rejected', array['schema_violation']),

  ('chave_inconsistente',
   'Chave de acesso inconsistente com o documento',
   'Dígito verificador inválido, ou CNPJ do emitente divergente do que está na chave. '
   'Indica documento remontado ou chave de outra nota colada no arquivo.',
   2, 'critical', 'none', 'output_rejected', array['schema_violation']),

  ('documento_duplicado',
   'Documento recebido em duplicidade',
   'A mesma chave de acesso foi enviada mais de uma vez. Só a primeira entrou na '
   'apuração; contar duas vezes dobraria débito ou crédito.',
   2, 'medium', 'both', 'output_rejected', array['duplicate_document']),

  ('cclasstrib_vs_cst',
   'cClassTrib incompatível com CST-IBS/CBS',
   'Os dois códigos existem isoladamente, mas a combinação é inválida. É o erro de '
   'mérito que a SEFAZ autoriza na emissão e a apuração pune.',
   3, 'critical', 'reform', 'item_classification', array['code_incompatible']),

  ('codigo_inexistente',
   'Código fora da tabela oficial',
   'NCM, CFOP, NBS ou CST que não existe na tabela vigente.',
   3, 'high', 'both', 'item_classification', array['unknown_code']),

  ('formato_de_codigo',
   'Código fora do formato',
   'Quantidade de dígitos ou caractere inválido — NCM com 7 dígitos, CFOP com 5, '
   'cClassTrib com letra.',
   2, 'critical', 'both', 'item_classification', array['schema_violation']),

  ('item_sem_classificacao_reforma',
   'Item sem classificação de IBS/CBS',
   'Falta CST-IBS/CBS ou cClassTrib no cadastro. Não é erro hoje: é o trabalho que '
   'falta para o CNPJ estar pronto para a apuração de 2027.',
   3, 'medium', 'reform', 'item_classification', array['missing_reform_classification']),

  ('codigo_nao_verificado',
   'Código não verificado por falta de tabela oficial',
   'A tabela de referência não está carregada, então o código não pôde ser conferido. '
   'Ausência de erro aqui NÃO significa que está correto.',
   3, 'low', 'both', 'item_classification', array['not_verified']),

  ('item_sem_grupo_ub',
   'Nota emitida sem o grupo IBS/CBS',
   'O documento não traz o grupo UB, então o lado novo da apuração não pôde ser '
   'conferido contra a nota. Mede a prontidão da cadeia de fornecedores.',
   2, 'medium', 'reform', 'assessment', array['missing_reform_group']),

  ('regra_nao_publicada',
   'Valor devido não determinável',
   'Sem regra de creditamento publicada para a competência, débito e crédito potencial '
   'são somados mas o valor devido não é calculado. Não é erro do contribuinte.',
   null, 'medium', 'both', 'assessment', array['rule_not_published']),

  ('projecao_divergente',
   'Projeção não fecha com o event log',
   'O hash da apuração não corresponde ao replay dos eventos. Nenhum número da '
   'competência deve ser considerado válido até isto ser resolvido.',
   7, 'critical', 'both', 'output_rejected', array['verification_mismatch']),

  ('competencia_nao_confirmada',
   'Competência aberta no fechamento',
   'A competência não chegou a ser confirmada. Sem confirmação não há hash de '
   'fechamento, e portanto não há trilha de defesa para os números do mês.',
   null, 'high', 'both', 'period_state', array['open','assessed','reconciled'])

on conflict (trail_id) do update set
  name = excluded.name,
  description = excluded.description,
  layer = excluded.layer,
  default_severity = excluded.default_severity,
  tax_scope = excluded.tax_scope,
  source = excluded.source,
  matches = excluded.matches;

-- ------------------------------------------- correção de estrutura da Onda 5
--
-- `item_classifications.health_reasons` guardava apenas as MENSAGENS das
-- inconsistências. As trilhas de auditoria precisam agrupar por `reason`, e
-- casar por trecho de mensagem seria frágil: mudar o texto de um aviso quebraria
-- a agregação em silêncio.
--
-- A coluna passa a guardar a inconsistência inteira (reason, severity, field,
-- message, suggestedFix). A renomeação é segura porque a estrutura é nova e não
-- há classificação em produção; se houvesse, o caminho seria backfill.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'item_classifications'
       and column_name = 'health_reasons'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'item_classifications'
       and column_name = 'health_issues'
  ) then
    alter table public.item_classifications rename column health_reasons to health_issues;
  end if;
end $$;

alter table public.item_classifications
  add column if not exists health_issues jsonb not null default '[]'::jsonb;

comment on column public.item_classifications.health_issues is
  'Inconsistências completas (reason, severity, field, message, suggestedFix). As trilhas agrupam por reason.';

-- ----------------------------------------------------------------- Book
--
-- Os BYTES do PDF ficam guardados, não são regerados sob demanda. O Book é um
-- documento entregue a terceiro e carrega um hash no rodapé: regerar depois de
-- uma regra mudar produziria um arquivo diferente com o mesmo número de
-- identificação, e o contador perderia a capacidade de mostrar o que enviou.
create table if not exists public.books (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  cnpj             char(14) not null,
  period           char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  audience         text not null check (audience in ('accountant', 'business_owner')),
  white_label      boolean not null default false,
  include_trace    boolean not null default true,

  -- Hash da projeção no instante da geração. Vai impresso no rodapé de cada
  -- página, e é por ele que o destinatário confere a autenticidade.
  projection_hash  text not null,
  trails_summary   jsonb not null default '{}'::jsonb,
  totals_snapshot  jsonb not null default '{}'::jsonb,
  pages            integer not null default 0,

  pdf              bytea not null,
  pdf_bytes        integer not null,
  -- SHA-256 do próprio PDF: detecta troca do arquivo por quem tenha escrita na tabela.
  pdf_sha256       char(64) not null,

  event_seq        bigint not null,
  generated_by     uuid,
  generated_at     timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists books_scope_idx
  on public.books (tenant_id, cnpj, period, generated_at desc);

alter table public.books enable row level security;
alter table public.audit_trails disable row level security;

drop policy if exists books_select_own on public.books;
create policy books_select_own on public.books
  for select using (public.is_member_of(tenant_id));

do $$
begin
  grant select on public.audit_trails to anon, authenticated;
exception when undefined_object then
  null;
end $$;


-- =============================================================================
-- PARTE 2 — bootstrap do escritório
--
-- Vincula um usuário do Supabase Auth a um escritório, como owner. Sem isso a
-- API responde 403 em tudo: o tenant é resolvido pela tabela `memberships`, e
-- nunca por um claim do token — um claim fica velho quando alguém sai do
-- escritório, e a sessão antiga continuaria valendo.
-- =============================================================================

do $bootstrap$
declare
  -- ┌──────────────────────────── CONFIGURE ────────────────────────────┐
  v_email       text := 'voce@seudominio.com.br';
  v_escritorio  text := 'Meu Escritório de Contabilidade';
  -- └───────────────────────────────────────────────────────────────────┘

  v_user_id     uuid;
  v_confirmado  boolean;
  v_tenant_id   uuid;
  v_existente   text;
begin
  select id, email_confirmed_at is not null
    into v_user_id, v_confirmado
    from auth.users
   where lower(email) = lower(v_email);

  if v_user_id is null then
    raise exception using
      message = format('Nenhum usuário com e-mail %L em auth.users.', v_email),
      hint = 'Crie em Authentication → Users → Add user, marcando "Auto Confirm User".';
  end if;

  if not v_confirmado then
    raise warning 'E-mail % ainda não confirmado: o login vai falhar até confirmar.', v_email;
  end if;

  select t.name into v_existente
    from memberships m join tenants t on t.id = m.tenant_id
   where m.user_id = v_user_id
   limit 1;

  if v_existente is not null then
    raise notice 'Usuário já pertence a %. Nada a criar.', v_existente;
    return;
  end if;

  insert into tenants (name) values (v_escritorio) returning id into v_tenant_id;
  insert into memberships (tenant_id, user_id, role)
       values (v_tenant_id, v_user_id, 'owner');

  raise notice 'Escritório % criado; % vinculado como owner.', v_escritorio, v_email;
end
$bootstrap$;

-- =============================================================================
-- PARTE 3 — conferência
--
-- Deve devolver uma linha com o seu e-mail e o papel owner.
-- =============================================================================

select
  t.id            as tenant_id,
  t.name          as escritorio,
  t.plan          as plano,
  u.email         as usuario,
  m.role          as papel,
  (select count(*) from plans)   as planos_carregados,
  (select minimum_cents from billing_settings where id) as minimo_centavos
from memberships m
join tenants t on t.id = m.tenant_id
join auth.users u on u.id = m.user_id
order by m.created_at desc
limit 5;
