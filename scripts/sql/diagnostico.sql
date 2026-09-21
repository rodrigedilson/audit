-- =============================================================================
-- audit — diagnóstico do banco
--
-- Cole no SQL Editor do Supabase. Não altera nada: só relata.
--
-- Serve para responder o que de fora não se distingue: uma tabela que devolve
-- lista vazia pela API REST pode estar sem dados OU com RLS ligada sem policy.
-- As duas situações são indistinguíveis para o cliente, e a correção é
-- diferente em cada caso.
-- =============================================================================

-- 1. Tabelas: as 15 que as migrations criam estão presentes?
select
  'tabelas' as checagem,
  count(*)  as encontradas,
  15        as esperadas,
  coalesce(
    string_agg(faltando, ', ') filter (where presente is null),
    '(nenhuma faltando)'
  ) as detalhe
from (
  select e.nome as faltando, t.table_name as presente
    from (values
      ('tenants'),('memberships'),('clients'),('periods'),('events'),
      ('projection_snapshots'),('jobs'),('certificates'),('plans'),
      ('billing_settings'),('subscriptions'),('invoices'),('billing_events'),
      ('documents'),('document_items')
    ) as e(nome)
    left join information_schema.tables t
      on t.table_schema = 'public' and t.table_name = e.nome
) x;

-- 2. Funções
select 'funcoes' as checagem, string_agg(routine_name, ', ' order by routine_name) as encontradas
  from information_schema.routines
 where routine_schema = 'public'
   and routine_name in ('current_user_id','is_member_of','append_event',
                        'billable_clients','events_reject_mutation');

-- 3. Trigger append-only de `events` (INV-001/INV-006)
select 'trigger append-only' as checagem,
       case when count(*) > 0 then 'ativo' else 'AUSENTE' end as estado
  from pg_trigger where tgname = 'events_append_only' and not tgisinternal;

-- 4. Carga inicial — a resposta que falta
--
-- Roda como `postgres`, então ignora RLS: se aqui houver 5 planos e a API REST
-- devolver [], a causa é RLS, não falta de dados.
select 'carga inicial' as checagem,
       (select count(*) from plans)            as planos,
       (select count(*) from billing_settings) as parametros,
       (select min(monthly_cents) from plans)  as menor_preco_centavos,
       (select minimum_cents from billing_settings where id) as minimo_centavos;

-- 5. Estado do RLS por tabela
--
-- `plans` e `billing_settings` devem aparecer com rls = false: a calculadora de
-- preço é pública. As demais com rls = true e uma policy de SELECT.
select 'rls' as checagem,
       c.relname as tabela,
       c.relrowsecurity as rls,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relname in ('plans','billing_settings','tenants','clients','events')
 order by c.relname;

-- 6. Escritório e usuário — sem isso a API responde 403 em tudo
select 'escritorio' as checagem,
       t.id as tenant_id, t.name as nome, u.email, m.role as papel,
       u.email_confirmed_at is not null as email_confirmado
  from tenants t
  left join memberships m on m.tenant_id = t.id
  left join auth.users u on u.id = m.user_id
 order by t.created_at;

-- 7. Contagens gerais, para saber se já houve movimento
select 'movimento' as checagem,
       (select count(*) from clients)   as cnpjs,
       (select count(*) from periods)   as competencias,
       (select count(*) from events)    as eventos,
       (select count(*) from documents) as documentos;
