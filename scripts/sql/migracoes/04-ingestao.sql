-- =============================================================================
-- audit — passo 4 de 40: ingestao
--
-- Documentos fiscais e seus itens, com tributos atuais e IBS/CBS lado a lado.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260918150000_ingestion.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

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
