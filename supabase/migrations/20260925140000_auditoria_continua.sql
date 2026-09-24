-- =============================================================================
-- Auditoria contínua: teste de comprovação e inspeção documentária
--
-- O método vem da perícia contábil: um lançamento é examinado por cinco
-- verificações vinculadas a um **critério de avaliação** rastreável. Passando
-- nas cinco há evidência de confiabilidade; falhando uma há distorção
-- relevante, e o perito invalida e estorna o lançamento, gerando saldo devedor
-- para uma parte e credor para a outra. Aqui as partes são o contribuinte e o
-- Fisco, e estornar crédito de entrada é exatamente isso.
--
-- O que o schema precisa tornar impossível, e por quê:
--
-- - **Afirmar sem critério conferido.** `evaluation_criteria` nasce com as
--   linhas necessárias e todas com `verified = false`: as citações foram
--   derivadas de leitura, não conferidas em texto oficial. A constraint
--   `criterios_conferidos_tem_fonte` impede marcar como conferido sem apontar o
--   texto. Enquanto não for conferido, o achado existe, aparece e **não afirma**
--   — `assertable = false`.
--
--   Nascer não conferida é estritamente melhor do que nascer vazia: o escritório
--   vê quais normas precisa confirmar, em vez de encontrar uma tabela vazia sem
--   saber o que falta.
--
-- - **Dizer "conferido" onde nada foi comparado.** `audit_executions.status`
--   tem `inconclusive`, e ele **não** é `completed` com zero achados. Sem essa
--   distinção a tela diria "limpo" para uma competência em que o critério não
--   estava carregado.
--
-- - **Estornar sem humano.** `audit_reversals.applied_by` é `not null`. O
--   sistema propõe; quem invalida um lançamento fiscal é uma pessoa
--   identificada. É a mesma regra que o produto já vende: nenhuma IA altera um
--   número fiscal sozinha.
--
-- Não há tabela de posição de achado por competência: o achado é derivado da
-- execução, e a execução é substituída quando a trilha roda de novo. O
-- identificador determinístico (`trilha:competência:sujeito`) é o que torna a
-- reexecução um `on conflict do update` em vez de um acúmulo — e é o que
-- preserva o `accepted` de um achado já revisado por humano.
-- =============================================================================

-- --------------------------------------------------------- critérios
create table if not exists public.evaluation_criteria (
  criterion_id  text primary key,
  kind          text not null check (kind in (
                  'constituicao', 'lei_complementar', 'lei_ordinaria',
                  'medida_provisoria', 'decreto', 'instrucao_normativa',
                  'portaria', 'resolucao', 'convenio_ou_ajuste', 'nota_tecnica',
                  'sumula', 'precedente', 'norma_contabil',
                  'invariante_do_produto', 'decisao_de_arquitetura',
                  'contrato_de_api'
                )),
  citation      text not null check (length(btrim(citation)) > 0),
  parameter     text not null check (length(btrim(parameter)) > 0),
  valid_from    date,
  valid_to      date,
  source_ref    text,
  verified      boolean not null default false,
  verified_by   uuid,
  verified_at   timestamptz,

  -- Os dentes da regra: conferido exige apontar o texto conferido.
  constraint criterios_conferidos_tem_fonte check (
    not verified or (source_ref is not null and length(btrim(source_ref)) > 0)
  )
);

/**
 * Os critérios que as trilhas iniciais citam. Todos NÃO conferidos.
 *
 * A citação saiu de leitura de doutrina e do briefing, e não da abertura do
 * texto oficial — que, no caso da LC 214, ainda é alterada por norma posterior.
 * Marcar `verified = true` aqui faria o produto afirmar "este crédito é
 * indevido conforme o art. X" sem que ninguém tenha aberto o art. X.
 */
insert into public.evaluation_criteria
  (criterion_id, kind, citation, parameter, valid_from, verified)
values
  ('lc-214-credito-documento-habil', 'lei_complementar',
   'LC 214/2025, art. 156-A',
   'O crédito de IBS/CBS exige documento hábil e idôneo que lastreie a operação.',
   '2026-01-01', false),
  ('lc-214-competencia-do-credito', 'lei_complementar',
   'LC 214/2025',
   'O crédito é apropriado na competência da emissão do documento.',
   '2026-01-01', false),
  ('lc-214-uso-e-consumo', 'lei_complementar',
   'LC 214/2025',
   'Bem de uso e consumo pessoal não gera direito a crédito.',
   '2026-01-01', false),
  ('it-rt-2025-002', 'nota_tecnica',
   'IT RT 2025.002',
   'A combinação de CST, cClassTrib, NCM e CFOP segue as tabelas oficiais.',
   '2026-01-01', false)
on conflict (criterion_id) do nothing;

alter table public.evaluation_criteria disable row level security;

-- --------------------------------------------------------- execuções
create table if not exists public.audit_executions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  cnpj                 char(14) not null,
  period               char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  procedure_id         text not null,

  status               text not null check (status in ('completed', 'inconclusive')),
  inconclusive_reason  text,

  population_size      integer not null default 0 check (population_size >= 0),
  examined_count       integer not null default 0 check (examined_count >= 0),
  findings_count       integer not null default 0 check (findings_count >= 0),
  total_impact_cents   bigint not null default 0,

  sampling_technique   text not null default 'censo'
                         check (sampling_technique in ('censo', 'aleatoria_simples', 'por_relevancia')),
  sampling_size        integer,
  sampling_seed        text,

  criterion_id         text not null references public.evaluation_criteria (criterion_id),
  criterion_verified   boolean not null default false,

  event_seq            bigint not null,
  executed_by          uuid,
  executed_at          timestamptz not null default now(),

  -- Inconclusivo sem motivo seria a mesma opacidade que a coluna existe para
  -- evitar: "não conferi" precisa dizer por quê.
  constraint execucao_inconclusiva_tem_motivo check (
    status <> 'inconclusive'
    or (inconclusive_reason is not null and length(btrim(inconclusive_reason)) > 0)
  ),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists audit_executions_scope_idx
  on public.audit_executions (tenant_id, cnpj, period, procedure_id, executed_at desc);

/** A fila do que ficou por conferir, que é o que o doctor e a tela precisam ver. */
create index if not exists audit_executions_inconclusivas_idx
  on public.audit_executions (tenant_id, cnpj, period)
  where status = 'inconclusive';

alter table public.audit_executions enable row level security;
drop policy if exists audit_executions_select_own on public.audit_executions;
create policy audit_executions_select_own on public.audit_executions
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------------------ achados
create table if not exists public.audit_findings (
  tenant_id       uuid not null,
  cnpj            char(14) not null,
  -- `trilha:competência:sujeito`. Determinístico, para reexecutar substituir.
  finding_id      text not null,

  execution_id    uuid not null references public.audit_executions (id) on delete cascade,
  procedure_id    text not null,
  period          char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  subject         text not null,
  subject_kind    text not null check (subject_kind in (
                    'documentos_de_entrada', 'documentos_de_saida',
                    'itens_do_catalogo', 'creditos_de_entrada'
                  )),

  -- As cinco com o resultado de cada, e as comparações que as sustentam.
  verifications   jsonb not null default '[]'::jsonb,
  failed          text[] not null default '{}',

  impact_cents    bigint not null default 0,
  impact_side     text not null check (impact_side in (
                    'credito_a_estornar', 'debito_a_constituir', 'sem_efeito_no_saldo'
                  )),

  likelihood      smallint check (likelihood between 1 and 5),
  impact          smallint check (impact between 1 and 5),
  risk_score      smallint check (risk_score between 1 and 25),
  severity        text not null check (severity in ('low', 'medium', 'high', 'critical')),
  -- O denominador da frequência: "5 de 5" e "5000 de 5000" dão a mesma
  -- probabilidade e não significam a mesma coisa para quem lê o Book.
  observed_failures integer not null default 0,
  observed_examined integer not null default 0,

  criterion_id    text not null references public.evaluation_criteria (criterion_id),
  assertable      boolean not null default false,

  status          text not null default 'open'
                    check (status in ('open', 'accepted', 'rejected', 'resolved')),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text,

  event_seq       bigint not null,

  -- Aceitar ou recusar é ato de humano; `resolved` vem de reexecução e não tem
  -- revisor. Discordar sem motivo escrito não é revisão.
  constraint achado_revisado_tem_revisor check (
    status not in ('accepted', 'rejected')
    or (reviewed_by is not null and reviewed_at is not null)
  ),
  constraint achado_recusado_tem_motivo check (
    status <> 'rejected' or (review_note is not null and length(btrim(review_note)) > 0)
  ),

  primary key (tenant_id, cnpj, finding_id),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

/** Fila de trabalho: o que está aberto, mais grave e mais caro primeiro. */
create index if not exists audit_findings_fila_idx
  on public.audit_findings (tenant_id, cnpj, period, status, severity, impact_cents desc);

/** "O que este documento tem contra ele" — o drill-down da tela. */
create index if not exists audit_findings_subject_idx
  on public.audit_findings (tenant_id, cnpj, subject);

alter table public.audit_findings enable row level security;
drop policy if exists audit_findings_select_own on public.audit_findings;
create policy audit_findings_select_own on public.audit_findings
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------------------ estornos
create table if not exists public.audit_reversals (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null,
  cnpj                     char(14) not null,
  finding_id               text not null,
  period                   char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  credit_reversed_cents    bigint not null default 0 check (credit_reversed_cents >= 0),
  debit_constituted_cents  bigint not null default 0 check (debit_constituted_cents >= 0),
  net_effect_cents         bigint not null,

  -- A verificação que fundamenta o estorno, e a norma contra a qual se julgou.
  verification             text not null,
  criterion_id             text not null references public.evaluation_criteria (criterion_id),
  citation                 text not null check (length(btrim(citation)) > 0),

  event_seq                bigint not null,
  -- O requisito humano, no schema: o sistema propõe, a pessoa invalida.
  applied_by               uuid not null,
  applied_at               timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

/** Um estorno por achado: aplicar duas vezes dobraria o efeito na apuração. */
create unique index if not exists audit_reversals_por_achado_idx
  on public.audit_reversals (tenant_id, cnpj, finding_id);

alter table public.audit_reversals enable row level security;
drop policy if exists audit_reversals_select_own on public.audit_reversals;
create policy audit_reversals_select_own on public.audit_reversals
  for select using (public.is_member_of(tenant_id));

do $$
begin
  grant select on public.evaluation_criteria to anon, authenticated;
exception
  when undefined_object then null;
end $$;
