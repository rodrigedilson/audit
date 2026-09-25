-- =============================================================================
-- audit — passo 6 de 38: apuracao-dual
--
-- Motor de regras com vigência por data, apuração dual e a memória de
-- cálculo linha por linha. A tabela `tax_rules` nasce VAZIA de propósito:
-- sem regra publicada o valor devido vem nulo com o motivo, nunca um
-- número assumido.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921130000_assessment.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

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
