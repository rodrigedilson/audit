-- =============================================================================
-- audit — passo 38 de 43: capag
--
-- CAPAG presumida: a fórmula de referência (doutrina, nunca conferida) e os
-- demonstrativos do REGULARIZE por CNPJ, extraídos trecho a trecho.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927200000_capag.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- CAPAG presumida: fórmula de referência e demonstrativos por CNPJ
--
-- A fórmula oficial da CAPAG-P não está em texto público. A Portaria PGFN
-- 6.757/2022 não traz coeficientes (art. 21 e 23) e remete a metodologia ao
-- REGULARIZE e ao e-CAC (art. 28), que só a mostram ao contribuinte, com login.
-- Daí as duas tabelas:
--
-- - `capag_reference_formulas`: a fórmula que um buscador achou em fonte
--   pública (doutrina). Serve de referência e NUNCA é conferida — não há texto
--   oficial público para bater. Uma constraint garante isso.
-- - `capag_statements`: o demonstrativo que o escritório recebeu do cliente,
--   extraído trecho a trecho. É a fonte oficial daquele CNPJ, e fica conferido
--   quando a fórmula dele, aplicada aos valores dele, chega à CAPAG impressa.
--
-- O documento não é guardado: só o que foi extraído, com o trecho literal de
-- cada número, e o SHA-256 do arquivo.
-- =============================================================================

create table if not exists public.capag_reference_formulas (
  formula_id         uuid primary key default gen_random_uuid(),
  capag_group        text not null check (capag_group in ('pessoa_fisica', 'pj_nao_simples', 'pj_simples', 'mei')),
  income_multiplier  numeric(12,6) not null,
  -- CapagTerm[] com o trecho de cada coeficiente.
  terms              jsonb not null,
  -- [{url, quotes}] — cada trecho conferido na página, buscada de novo pelo código.
  sources            jsonb not null,
  source_kind        text not null default 'doutrina' check (source_kind = 'doutrina'),
  legal_basis        text,
  model              text not null,
  extracted_at       timestamptz not null default now(),
  verified           boolean not null default false,
  constraint capag_referencia_nunca_conferida check (not verified)
);

create index if not exists capag_reference_grupo_idx
  on public.capag_reference_formulas (capag_group, extracted_at desc);

-- Global, como os índices: leitura só autenticada, escrita da service role.
alter table public.capag_reference_formulas disable row level security;
do $$
begin
  grant select on public.capag_reference_formulas to authenticated;
exception
  when undefined_object then null;
end $$;

create table if not exists public.capag_statements (
  statement_id          uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  cnpj                  char(14) not null,

  document_sha256       char(64) not null,
  document_kind         text not null check (document_kind in ('pdf', 'html', 'text')),
  reference_date        date,
  capag_group           text check (capag_group in ('pessoa_fisica', 'pj_nao_simples', 'pj_simples', 'mei')),

  -- A extração inteira, com printed e quote de cada número. É o que a tela
  -- mostra ao lado do valor: de onde ele saiu.
  extraction            jsonb not null,
  -- Lidos pelo código a partir do `printed`, e não pelo modelo.
  values_cents          jsonb not null default '{}'::jsonb,
  printed_capag_cents   bigint,
  total_debt_cents      bigint,
  printed_band          char(1) check (printed_band is null or printed_band in ('A', 'B', 'C', 'D')),
  computed_capag_cents  bigint,

  reproduces            boolean not null default false,
  verified              boolean not null default false,
  problems              jsonb not null default '[]'::jsonb,

  model                 text not null,
  imported_by           uuid,
  extracted_at          timestamptz not null default now(),
  event_seq             bigint not null,

  -- Conferido só quando reproduz, e sem nenhum problema.
  constraint capag_conferida_reproduz check (not verified or (reproduces and problems = '[]'::jsonb)),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists capag_statements_cnpj_idx
  on public.capag_statements (tenant_id, cnpj, extracted_at desc);

alter table public.capag_statements enable row level security;
drop policy if exists capag_statements_select_own on public.capag_statements;
create policy capag_statements_select_own on public.capag_statements
  for select using (public.is_member_of(tenant_id));
