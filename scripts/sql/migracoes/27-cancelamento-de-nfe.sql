-- =============================================================================
-- audit — passo 27 de 29: cancelamento-de-nfe
--
-- Cancelamento de NF-e pela distribuição: a nota cancelada fica marcada e
-- sai das somas, e todo evento trazido pela SEFAZ é guardado, inclusive o
-- que não pode ser aplicado por a competência já estar confirmada.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260926100000_cancelamento_de_nfe.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Cancelamento de NF-e trazido pela distribuição
--
-- A coleta (ADR-006) recebia o evento de cancelamento (110111) e o descartava:
-- a nota continuava em `documents`, e a apuração somava imposto de uma operação
-- que não existiu. O evento passa a ser guardado, e o cancelamento de nota que
-- está na base vira `doc.cancelled` no log.
--
-- A nota não sai de `documents`: o read model espelha o log, e o log não apaga.
-- Ela fica marcada, e quem soma ignora a marcada.
-- =============================================================================

alter table public.documents
  add column if not exists cancelled_at     timestamptz,
  add column if not exists cancel_protocol  text,
  add column if not exists cancel_event_seq bigint;

comment on column public.documents.cancelled_at is
  'Cancelamento homologado (evento 110111). Nota cancelada fica na base e sai das somas.';

-- Todo evento de NF-e que a distribuição trouxe, aplicado ou não. Guardar o que
-- não foi aplicado é o ponto: um cancelamento de competência já confirmada não
-- muda número nenhum (INV-001), e fica aqui como pendência de retificação.
create table if not exists public.dfe_events (
  tenant_id       uuid not null,
  cnpj            char(14) not null,
  access_key      char(44) not null,
  tp_evento       text not null,
  n_seq_evento    integer not null default 1,
  nsu             char(15) not null,
  cstat           text,
  protocolo       text,
  dh_evento       timestamptz,
  xml             text not null,
  received_at     timestamptz not null default now(),
  -- Virou evento no log (hoje, só o cancelamento).
  applied_at      timestamptz,
  -- Não será aplicado sozinho, e por quê.
  blocked_reason  text,
  primary key (tenant_id, cnpj, access_key, tp_evento, n_seq_evento),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade,
  constraint dfe_events_access_key_check check (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$')
);

create index if not exists dfe_events_pendentes_idx
  on public.dfe_events (tenant_id, cnpj)
  where applied_at is null and blocked_reason is null;

alter table public.dfe_events enable row level security;
drop policy if exists dfe_events_select_own on public.dfe_events;
create policy dfe_events_select_own on public.dfe_events
  for select using (public.is_member_of(tenant_id));

-- A propagação conta notas emitidas com a classificação do item. Nota cancelada
-- não foi emitida para efeito fiscal, e não entra na conta.
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
  ),
  linhas as (
    select di.code, di.total_cents, d.direction
      from public.document_items di
      join public.documents d
        on d.tenant_id = di.tenant_id and d.cnpj = di.cnpj and d.access_key = di.access_key
     where di.tenant_id = p_tenant_id and di.cnpj = p_cnpj
       and d.cancelled_at is null
  )
  select i.item_id,
         v.health,
         count(l.code) filter (where l.direction = 'outbound') as outbound_documents_affected,
         count(l.code) filter (where l.direction = 'inbound')  as inbound_documents_affected,
         coalesce(sum(l.total_cents), 0)                        as total_cents_affected
    from public.items i
    left join vigente v on v.item_id = i.item_id
    left join linhas l on l.code = i.item_id
   where i.tenant_id = p_tenant_id and i.cnpj = p_cnpj
   group by i.item_id, v.health;
$$;

-- `document_coverage` continua contando a cancelada: ela prova que a coleta
-- daquele mês existiu, que é o que a cobertura mede.
