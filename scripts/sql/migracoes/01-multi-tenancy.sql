-- =============================================================================
-- audit — passo 1 de 35: multi-tenancy
--
-- Escritórios, usuários, CNPJs, competências e o event log.
-- Cria append_event(), que serializa a escrita por CNPJ, e o trigger que
-- torna a tabela de eventos append-only.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260918120000_multi_tenancy.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

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
