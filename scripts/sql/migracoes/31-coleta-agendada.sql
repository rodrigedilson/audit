-- =============================================================================
-- audit — passo 31 de 37: coleta-agendada
--
-- Coleta de DF-e agendada por opt-in do owner (ADR-007): quem ligou e quando
-- ficam no cadastro, e o job do agendador é marcado como tal.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260926140000_coleta_agendada.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Coleta de DF-e agendada, por opt-in do cliente (ADR-007)
--
-- A coleta só rodava quando alguém pedia. Com a opção ligada pelo owner, o
-- agendador enfileira a coleta sozinho: o A1 passa a ser usado sem alguém
-- acionando, e por isso é opt-in por CNPJ, com quem ligou e quando.
-- =============================================================================

alter table public.clients
  add column if not exists dfe_auto_sync    boolean not null default false,
  add column if not exists dfe_auto_sync_by uuid,
  add column if not exists dfe_auto_sync_at timestamptz;

comment on column public.clients.dfe_auto_sync is
  'Coleta de DF-e agendada ligada pelo owner (ADR-007). O A1 é usado sem alguém acionando.';

-- Job do agendador não tem quem pediu: `requested_by` fica nulo, e o `trigger`
-- diz por quê. O uso do certificado sai em nome do orquestrador (`closer`),
-- com quem ligou a opção no payload do `certificate.used`.
alter table public.jobs
  add column if not exists trigger text not null default 'manual'
    check (trigger in ('manual', 'schedule'));

create index if not exists clients_dfe_auto_sync_idx
  on public.clients (tenant_id, cnpj)
  where dfe_auto_sync;

-- O rótulo prometia "automática" antes de haver agendamento. Agora há, e só
-- quando o cliente liga.
update public.plan_features
   set description = 'Busca as notas na SEFAZ com o certificado A1: sozinha, a cada hora, quando '
                  || 'o owner liga a coleta agendada, ou quando alguém pede.',
       updated_at = now()
 where key = 'coleta_dfe';
