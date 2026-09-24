-- =============================================================================
-- audit — passo 5 de 19: catalogo-de-itens
--
-- Catálogo de itens com classificação versionada por vigência, tabelas de
-- códigos oficiais e as funções effective_classification() e
-- item_propagation() — esta última responde quantas notas emitidas cada
-- item mal classificado contaminou.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921120000_catalog.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

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
