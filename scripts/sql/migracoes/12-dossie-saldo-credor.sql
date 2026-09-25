-- =============================================================================
-- audit — passo 12 de 40: dossie-saldo-credor
--
-- EFD-Contribuições importada e a janela de cobertura documental. O dossiê de
-- saldo credor NÃO é gravado: é derivado da escrituração mais a base de
-- documentos de agora, porque congelá-lo esconderia o ganho de lastro de
-- quando o escritório localiza um XML que faltava.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921190000_credit_dossier.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 12 — dossiê de saldo credor PIS/Cofins (diferencial #9)
--
-- A tese comercial: crédito sem lastro documental será perdido no pente-fino, e
-- a Nota Técnica RFB 011/2026 restringe a EFD-Contribuições a retificação e
-- saldos a partir de 2027 — o que faz do saldo credor acumulado um ativo com
-- prazo para ser defendido. É upsell de Lucro Presumido e Real.
--
-- **A honestidade central:** a ausência de um documento na nossa base não prova
-- que o crédito é indevido. Se o escritório só começou a ingerir XML em 2026,
-- um crédito de 2023 não tem como ser conferido aqui, e reportá-lo como "sem
-- documento" acusaria o cliente de um problema que é nosso. Por isso a janela de
-- cobertura entra no dossiê e `nao_verificavel` é um estado de primeira classe —
-- mesma regra do `not_verified` do catálogo e do `not_applicable` das trilhas.
--
-- O dossiê **não é gravado como resultado**, e isso é decisão: ele é derivado da
-- EFD importada mais a base de documentos de agora. Congelá-lo esconderia o
-- ganho de lastro que acontece quando o escritório localiza um XML que faltava —
-- e localizar documento é justamente o trabalho que o dossiê encomenda.
-- =============================================================================

do $$
begin
  create type public.sped_kind as enum ('original', 'retificadora');
exception when duplicate_object then
  null;
end $$;

create table if not exists public.sped_files (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  period        char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  kind          public.sped_kind not null,
  layout_version text not null,
  reference     text not null,
  company_name  text,

  documents_count integer not null default 0,
  rejected_count  integer not null default 0,
  /** Registros lidos por tipo, para o usuário conferir o que entrou. */
  counts        jsonb not null default '{}'::jsonb,

  event_seq     bigint not null,
  imported_by   uuid,
  imported_at   timestamptz not null default now(),

  -- Uma escrituração por competência: a retificadora substitui a original, como
  -- na própria EFD. Manter as duas daria dois saldos credores para o mesmo mês.
  unique (tenant_id, cnpj, period),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

alter table public.sped_files enable row level security;
drop policy if exists sped_files_select_own on public.sped_files;
create policy sped_files_select_own on public.sped_files
  for select using (public.is_member_of(tenant_id));

/** Documentos e itens como a EFD os declarou — o que o cliente afirmou ao Fisco. */
create table if not exists public.sped_documents (
  id            bigserial primary key,
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  sped_file_id  uuid not null references public.sped_files (id) on delete cascade,

  operation     text not null check (operation in ('inbound', 'outbound')),
  model         text not null,
  access_key    char(44),
  document_number text,
  issued_at     date,
  total_cents   bigint not null default 0,

  -- Somados dos itens: é por eles que o lastro é conferido.
  pis_cents     bigint not null default 0,
  cofins_cents  bigint not null default 0
);

create index if not exists sped_documents_chave_idx
  on public.sped_documents (tenant_id, cnpj, access_key);

alter table public.sped_documents enable row level security;
drop policy if exists sped_documents_select_own on public.sped_documents;
create policy sped_documents_select_own on public.sped_documents
  for select using (public.is_member_of(tenant_id));

/** Saldo credor de períodos anteriores, dos registros 1100 e 1500. */
create table if not exists public.sped_carried_credits (
  id            bigserial primary key,
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  sped_file_id  uuid not null references public.sped_files (id) on delete cascade,

  tax           text not null check (tax in ('pis', 'cofins')),
  origin_period char(7) not null,
  credit_code   text not null,
  origin        text not null,

  apured_cents        bigint not null default 0,
  available_cents     bigint not null default 0,
  used_cents          bigint not null default 0,
  refunded_cents      bigint not null default 0,
  final_balance_cents bigint not null default 0
);

create index if not exists sped_carried_idx
  on public.sped_carried_credits (tenant_id, cnpj, tax, origin_period);

alter table public.sped_carried_credits enable row level security;
drop policy if exists sped_carried_select_own on public.sped_carried_credits;
create policy sped_carried_select_own on public.sped_carried_credits
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------- janela de cobertura
--
-- Competências em que este sistema tem documento ingerido. É o que separa
-- "crédito sem lastro" de "não temos os documentos daquele mês" — a distinção
-- que torna o dossiê defensável em vez de acusatório.
create or replace function public.document_coverage(
  p_tenant uuid,
  p_cnpj char(14)
)
returns table (period char(7), documents integer)
language sql
stable
security definer
set search_path = public
as $$
  select d.period, count(*)::integer as documents
    from public.documents d
   where d.tenant_id = p_tenant and d.cnpj = p_cnpj
   group by d.period
   order by d.period;
$$;

comment on function public.document_coverage is
  'Competências com documento ingerido. Crédito de competência fora desta janela '
  'é "não verificável", e não "sem lastro": a ausência é da nossa coleta.';
