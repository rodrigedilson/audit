-- =============================================================================
-- audit — passo 18 de 27: efd_icms_ipi
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924120000_efd_icms_ipi.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- EFD ICMS/IPI: a segunda escrituração.
--
-- A `sped_files` nasceu para a EFD-Contribuições e tem `unique (tenant_id, cnpj,
-- period)`. Agora há duas escriturações por competência — a federal de PIS/Cofins
-- e a estadual de ICMS/IPI — e a unicidade passa a incluir qual delas é. Sem
-- isso, importar a EFD ICMS/IPI de janeiro apagaria a EFD-Contribuições do mesmo
-- mês, e o dossiê de saldo credor sumiria sem aviso.

alter table public.sped_files
  add column if not exists layout text not null default 'contribuicoes'
  check (layout in ('contribuicoes', 'icms_ipi'));

comment on column public.sped_files.layout is
  'Qual escrituração este arquivo é. As linhas que já existiam são todas de '
  'EFD-Contribuições, que era a única que o produto lia.';

-- A constraint antiga não tem nome declarado, então foi o Postgres que o deu.
-- Procurá-la pela definição, em vez de chutar o nome, deixa esta migration
-- rodar tanto num banco que já a tem quanto num criado do zero depois dela.
do $$
declare
  antiga text;
begin
  select conname into antiga
    from pg_constraint
   where conrelid = 'public.sped_files'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, cnpj, period)';

  if antiga is not null then
    execute format('alter table public.sped_files drop constraint %I', antiga);
  end if;
end
$$;

alter table public.sped_files
  drop constraint if exists sped_files_escrituracao_unica;

alter table public.sped_files
  add constraint sped_files_escrituracao_unica
  unique (tenant_id, cnpj, period, layout);

/**
 * Documentos da EFD ICMS/IPI, reduzidos ao que as conferências usam.
 *
 * Guardar item a item (C170) custaria milhões de linhas por carteira para
 * responder às mesmas somas. O que a conciliação precisa é, por documento: o
 * total de ICMS dos itens, o total da consolidação (C190) e o do próprio C100.
 *
 * `has_items` e `has_analytics` existem porque soma zero e registro ausente não
 * são a mesma coisa: NF-e de emissão própria costuma vir sem C170, e tratar isso
 * como divergência acusaria o cliente por seguir o guia.
 */
create table if not exists public.efd_icms_documents (
  id            bigserial primary key,
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  sped_file_id  uuid not null references public.sped_files (id) on delete cascade,

  subject       text not null,
  operation     text not null check (operation in ('inbound', 'outbound')),
  -- COD_SIT cru: 02 e 03 cancelado, 04 denegado, 05 numeração inutilizada.
  situation     char(2) not null,

  has_items     boolean not null default false,
  has_analytics boolean not null default false,

  items_icms_cents     bigint not null default 0,
  analytics_icms_cents bigint not null default 0,
  document_icms_cents  bigint not null default 0
);

create index if not exists efd_icms_documents_arquivo_idx
  on public.efd_icms_documents (sped_file_id);

alter table public.efd_icms_documents enable row level security;
drop policy if exists efd_icms_documents_select_own on public.efd_icms_documents;
create policy efd_icms_documents_select_own on public.efd_icms_documents
  for select using (public.is_member_of(tenant_id));

/**
 * Apuração declarada: E110 para o ICMS, E520 para o IPI.
 *
 * Todo campo é anulável porque o arquivo pode trazer um registro e não o outro,
 * e arquivo sem E110 não é arquivo com ICMS zerado. Gravar zero aqui faria a
 * conferência dizer "confere" sobre algo que o arquivo não declarou.
 */
create table if not exists public.efd_icms_assessments (
  sped_file_id  uuid primary key references public.sped_files (id) on delete cascade,
  tenant_id     uuid not null,
  cnpj          char(14) not null,

  -- E110, campos 2 a 15.
  icms_total_debits_cents              bigint,
  icms_document_debit_adjustments_cents bigint,
  icms_adjustment_debits_cents         bigint,
  icms_credit_reversals_cents          bigint,
  icms_total_credits_cents             bigint,
  icms_document_credit_adjustments_cents bigint,
  icms_adjustment_credits_cents        bigint,
  icms_debit_reversals_cents           bigint,
  icms_previous_credit_balance_cents   bigint,
  icms_assessed_balance_cents          bigint,
  icms_deductions_cents                bigint,
  icms_payable_cents                   bigint,
  icms_carried_credit_balance_cents    bigint,
  icms_extra_assessment_cents          bigint,

  -- E520, campos 2 a 8.
  ipi_previous_credit_balance_cents bigint,
  ipi_debits_cents                  bigint,
  ipi_credits_cents                 bigint,
  ipi_other_debits_cents            bigint,
  ipi_other_credits_cents           bigint,
  ipi_carried_credit_balance_cents  bigint,
  ipi_payable_cents                 bigint,

  -- `true` quando o arquivo trouxe o registro. Distingue ausência de zero.
  has_icms boolean not null default false,
  has_ipi  boolean not null default false
);

alter table public.efd_icms_assessments enable row level security;
drop policy if exists efd_icms_assessments_select_own on public.efd_icms_assessments;
create policy efd_icms_assessments_select_own on public.efd_icms_assessments
  for select using (public.is_member_of(tenant_id));
