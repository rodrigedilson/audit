-- =============================================================================
-- audit — passo 23 de 42: diagnostico-publico
--
-- Métrica agregada do diagnóstico público de prontidão. Uma linha por
-- diagnóstico, sem CNPJ, chave de acesso ou razão social: o relatório é
-- calculado em memória e nada do documento do visitante é guardado.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924190000_diagnostico_publico.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Diagnóstico público de prontidão para a reforma
--
-- O visitante sobe XMLs no site e recebe o retrato de quantos dos seus
-- fornecedores já emitem com o grupo UB da NT 2025.002 — sem criar conta.
--
-- UMA linha por diagnóstico, e **nada que identifique a carteira do visitante**:
-- sem CNPJ, sem chave de acesso, sem razão social, sem NCM. O produto promete
-- que não guarda os documentos de quem experimenta; gravar o que foi
-- diagnosticado desmentiria a promessa na primeira auditoria. O que fica são
-- contadores, que servem para medir o funil e para impor a quota diária.
-- =============================================================================

create table if not exists public.readiness_reports (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),

  -- sha256(salt + ip). O IP cru nunca entra: serve para limitar abuso, não para
  -- perfilar visitante. Um produto que se vende como custódia responsável não
  -- guarda IP de anônimo para medir marketing.
  ip_hash                char(64) not null,

  documents_total        integer not null default 0,
  documents_parsed       integer not null default 0,
  documents_rejected     integer not null default 0,
  documents_with_reform  integer not null default 0,
  items_total            integer not null default 0,
  items_with_reform      integer not null default 0,
  distinct_issuers       integer not null default 0,
  distinct_ncms          integer not null default 0,
  periods_covered        integer not null default 0,

  -- Lead. Opcional e sempre POSTERIOR ao relatório: o diagnóstico nunca fica
  -- atrás do e-mail. Muro de e-mail é a opacidade que o produto combate, e a
  -- calculadora de preço pública já estabeleceu essa regra.
  email                  text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  email_consent_at       timestamptz,
  source                 text,

  -- Consentimento como invariante de banco, não como disciplina de código: um
  -- bug no handler não consegue gravar lead sem consentimento.
  constraint readiness_email_exige_consentimento
    check (email is null or email_consent_at is not null)
);

comment on table public.readiness_reports is
  'Métrica agregada do diagnóstico público. Sem CNPJ, chave de acesso ou razão social.';

-- A consulta da quota é sempre (ip_hash, janela recente).
create index if not exists readiness_reports_quota_idx
  on public.readiness_reports (ip_hash, created_at desc);

create index if not exists readiness_reports_lead_idx
  on public.readiness_reports (created_at desc)
  where email is not null;

-- Sem `tenant_id`: a tabela é anônima por construção e `is_member_of` não se
-- aplica. RLS ligada SEM policy de select — ninguém lê pelo cliente; a API lê
-- com a service role. É a mesma "segunda tranca" do resto do schema.
alter table public.readiness_reports enable row level security;
