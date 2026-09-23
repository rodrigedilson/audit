-- =============================================================================
-- audit — passo 8 de 16: contra-apuracao
--
-- Proposta do Fisco, divergências nota a nota e o calendário da carteira.
-- `deadline_rules` nasce VAZIA de propósito: as datas da janela do art.
-- 40-D e dos prazos da apuração assistida citadas no briefing não foram
-- conferidas em texto oficial, e alertar na data errada é pior do que não
-- alertar — o escritório passa a confiar.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921150000_reconciliation.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 8 — contra-apuração e calendário (diferencial #5)
--
-- A apuração assistida inverte o ônus: o Fisco propõe o número e o silêncio do
-- contribuinte vale como concordância. Este módulo compara a nossa apuração com
-- a proposta do Fisco **nota a nota** e nomeia a causa provável de cada
-- diferença, para que a resposta seja uma discordância fundamentada e não uma
-- planilha de totais.
--
-- Duas honestidades embutidas no schema:
--
-- 1. O formato oficial de exposição da apuração assistida ainda está em piloto
--    (Portaria RE 013/2026 RS, citada no briefing e NÃO conferida em texto
--    oficial). Por isso a origem da proposta é um campo, o layout de upload
--    manual é NOSSO e está documentado, e há espaço para `official_api` sem
--    migration nova.
-- 2. Uma proposta só com totais é registrada como só-totais. Sem isso, um
--    upload sem detalhe produziria "nenhuma divergência nota a nota", que o
--    contador leria como "confere" quando na verdade nada foi comparado.
-- =============================================================================

do $$
begin
  create type public.fisco_source as enum ('manual_upload', 'official_api');
exception when duplicate_object then
  null;
end $$;

-- ------------------------------------------------- proposta do Fisco
create table if not exists public.fisco_assessments (
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  period        char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  source        public.fisco_source not null default 'manual_upload',
  -- De onde o arquivo veio, em texto livre: nome do arquivo, protocolo, print
  -- do portal. É o que permite ao contador dizer depois o que recebeu e quando.
  reference     text not null,

  /**
   * `false` quando a proposta só trouxe totais por tributo.
   *
   * A comparação nota a nota é o produto; sem detalhe ela não acontece, e o
   * resultado tem de dizer isso em vez de reportar zero divergências.
   */
  line_level    boolean not null default false,

  totals        jsonb not null default '{}'::jsonb,
  lines_count   integer not null default 0,

  event_seq     bigint not null,
  uploaded_by   uuid,
  uploaded_at   timestamptz not null default now(),

  primary key (tenant_id, cnpj, period),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

alter table public.fisco_assessments enable row level security;
drop policy if exists fisco_assessments_select_own on public.fisco_assessments;
create policy fisco_assessments_select_own on public.fisco_assessments
  for select using (public.is_member_of(tenant_id));

-- Espelha `assessment_lines`, para a comparação ser uma junção e não um parse.
create table if not exists public.fisco_assessment_lines (
  id            bigserial primary key,
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  period        char(7) not null,

  access_key    char(44) not null,
  line          smallint not null,
  tax           text not null,
  direction     text not null check (direction in ('inbound', 'outbound')),

  base_cents    bigint not null default 0,
  rate          numeric(7,4) not null default 0,
  amount_cents  bigint not null default 0,

  foreign key (tenant_id, cnpj, period)
    references public.fisco_assessments (tenant_id, cnpj, period) on delete cascade
);

create index if not exists fisco_lines_scope_idx
  on public.fisco_assessment_lines (tenant_id, cnpj, period, access_key, line, tax);

alter table public.fisco_assessment_lines enable row level security;
drop policy if exists fisco_lines_select_own on public.fisco_assessment_lines;
create policy fisco_lines_select_own on public.fisco_assessment_lines
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------- divergências apuradas
--
-- Persistidas, e não recalculadas na leitura: a divergência é o que o contador
-- vai contestar, e ele precisa mostrar depois o que o sistema apontou com a
-- proposta daquele dia. Recalcular depois de reapurar mudaria a lista sem
-- mudar a contestação já protocolada.
create table if not exists public.assessment_divergences (
  id              bigserial primary key,
  tenant_id       uuid not null,
  cnpj            char(14) not null,
  period          char(7) not null,

  scope           text not null check (scope in ('tributo', 'documento', 'item')),
  subject         text not null,
  tax             text not null,
  direction       text check (direction in ('inbound', 'outbound')),
  access_key      char(44),
  line            smallint,

  our_cents       bigint not null default 0,
  fisco_cents     bigint not null default 0,
  -- Fisco menos nosso. Positivo = o Fisco aponta mais do que escrituramos.
  difference_cents bigint not null default 0,

  probable_cause  text not null,
  severity        text not null check (severity in ('low','medium','high','critical')),

  event_seq       bigint not null,
  created_at      timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists divergences_scope_idx
  on public.assessment_divergences (tenant_id, cnpj, period, severity);

alter table public.assessment_divergences enable row level security;
drop policy if exists divergences_select_own on public.assessment_divergences;
create policy divergences_select_own on public.assessment_divergences
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------- calendário de prazos
--
-- Duas naturezas, deliberadamente separadas:
--
-- `derivado` sai do estado do sistema (competência aberta com o mês encerrado,
-- apuração não confirmada, certificado vencendo). São fatos nossos, e o produto
-- pode afirmá-los.
--
-- `normativo` sai de norma, e cada linha carrega a base legal. A tabela nasce
-- **vazia**: as datas da janela de opção de regime do art. 40-D e dos prazos da
-- apuração assistida citadas por terceiros no briefing não foram conferidas em
-- texto oficial, e semear uma delas faria o produto alertar na data errada — o
-- que é pior do que não alertar, porque o escritório passa a confiar.
create table if not exists public.deadline_rules (
  rule_id       text primary key,
  name          text not null,
  description   text not null,
  nature        text not null check (nature in ('derivado', 'normativo')),

  -- Regimes a que se aplica; `null` vale para todos.
  applies_to_regimes public.regime[],

  /**
   * Como a data sai da competência, para as regras normativas.
   *
   * `months_after` meses após o primeiro dia da competência, e `day_of_month` o
   * dia. Deixados nulos quando a data é fixa em `fixed_date`.
   */
  months_after  smallint,
  day_of_month  smallint check (day_of_month between 1 and 31),
  fixed_date    date,

  -- Dias de antecedência do alerta.
  warn_days     smallint not null default 15,
  severity      text not null check (severity in ('low','medium','high','critical')),

  -- Base legal. Vazio é proibido: prazo sem fonte não entra no calendário.
  legal_basis   text not null check (length(trim(legal_basis)) > 0),
  active        boolean not null default true,

  constraint deadline_rules_tem_derivacao check (
    nature = 'derivado'
    or fixed_date is not null
    or (months_after is not null and day_of_month is not null)
  )
);

alter table public.deadline_rules disable row level security;

do $$
begin
  grant select on public.deadline_rules to anon, authenticated;
exception when undefined_object then
  null;
end $$;

comment on table public.deadline_rules is
  'Prazos normativos com base legal. Nasce vazia de propósito: as datas citadas '
  'por terceiros no briefing não foram conferidas em texto oficial.';

-- ------------------------------------------------- prazos concretos
create table if not exists public.deadlines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  period        char(7),

  rule_id       text references public.deadline_rules (rule_id),
  kind          text not null,
  name          text not null,
  due_date      date not null,
  severity      text not null check (severity in ('low','medium','high','critical')),

  /**
   * `normativo` é prazo de norma e exige base legal. `fato` é data que o próprio
   * sistema conhece — a validade de um certificado A1, por exemplo.
   *
   * A distinção é obrigatória porque o escritório age diferente nos dois casos:
   * perder um prazo normativo tem consequência legal, e a tela não pode deixar
   * um alvo interno passar por prazo de lei.
   */
  nature        text not null check (nature in ('normativo', 'fato')),
  legal_basis   text,
  constraint deadlines_normativo_tem_base check (
    nature <> 'normativo' or (legal_basis is not null and length(trim(legal_basis)) > 0)
  ),

  state         text not null default 'pending'
                check (state in ('pending', 'met', 'missed', 'dismissed')),
  met_at        timestamptz,
  -- Seq do `deadline.approaching` que avisou; null enquanto ninguém foi avisado.
  notified_seq  bigint,

  created_at    timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

-- Um prazo por regra, CNPJ e competência: reprocessar o calendário não duplica.
create unique index if not exists deadlines_unicos_idx
  on public.deadlines (tenant_id, cnpj, kind, coalesce(period, ''));

create index if not exists deadlines_agenda_idx
  on public.deadlines (tenant_id, state, due_date);

alter table public.deadlines enable row level security;
drop policy if exists deadlines_select_own on public.deadlines;
create policy deadlines_select_own on public.deadlines
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------- agenda da carteira
--
-- A visão que o escritório abre de manhã: o que vence em toda a carteira, e não
-- num CNPJ por vez. É a diferença entre um calendário e uma lista de tarefas.
create or replace function public.portfolio_deadlines(
  p_tenant uuid,
  p_horizon_days integer default 30
)
returns table (
  cnpj          char(14),
  legal_name    text,
  regime        public.regime,
  period        char(7),
  kind          text,
  name          text,
  due_date      date,
  days_left     integer,
  severity      text,
  nature        text,
  legal_basis   text,
  state         text
)
language sql
stable
security definer
set search_path = public
as $$
  select d.cnpj,
         c.legal_name,
         c.regime,
         d.period,
         d.kind,
         d.name,
         d.due_date,
         (d.due_date - current_date)::integer as days_left,
         d.severity,
         d.nature,
         d.legal_basis,
         d.state
    from public.deadlines d
    join public.clients c on c.tenant_id = d.tenant_id and c.cnpj = d.cnpj
   where d.tenant_id = p_tenant
     and d.state = 'pending'
     and d.due_date <= current_date + make_interval(days => p_horizon_days)
   order by d.due_date, d.severity desc, d.cnpj;
$$;

comment on function public.portfolio_deadlines is
  'Prazos DATADOS pendentes da carteira no horizonte dado. `days_left` negativo é '
  'prazo vencido. As pendências derivadas do estado do sistema não estão aqui: são '
  'função do estado de agora e são calculadas na leitura, para não envelhecerem em tabela.';
