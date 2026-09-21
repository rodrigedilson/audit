-- =============================================================================
-- audit — diagnóstico do banco
--
-- Cole no SQL Editor do Supabase e execute. Não altera nada: só relata.
--
-- Devolve UM único resultado, de propósito. O SQL Editor do Supabase mostra
-- apenas a saída da última instrução quando o script tem várias, então uma
-- versão com vários SELECT esconderia todas as checagens menos a final — e a
-- última linha ser "0 CNPJs, 0 eventos" numa instalação nova parece, de fora,
-- que nada funcionou.
--
-- Responde também o que a API REST não distingue: uma tabela que devolve lista
-- vazia pode estar SEM DADOS ou com RLS LIGADA sem policy. Este script roda como
-- `postgres` e ignora RLS, então mostra as duas coisas lado a lado.
-- =============================================================================

do $diag$
declare
  v_tabelas    text[] := array[
    'tenants','memberships','clients','periods','events','projection_snapshots',
    'jobs','certificates','plans','billing_settings','subscriptions','invoices',
    'billing_events','documents','document_items'
  ];
  v_funcoes    text[] := array[
    'current_user_id','is_member_of','append_event','billable_clients',
    'events_reject_mutation'
  ];
  v_faltando   text[];
  v_presentes  int;
  v_planos     int := 0;
  v_parametros int := 0;
  v_tem_auth   boolean := to_regclass('auth.users') is not null;
  v_linha      text;
begin
  -- Sem `on commit drop`: o bloco DO roda na sua propria transacao, e a tabela
  -- seria descartada antes do SELECT final. Fica na sessao e o Postgres a
  -- remove ao desconectar.
  create temporary table if not exists diagnostico_audit (
    ordem    int,
    checagem text,
    estado   text,
    detalhe  text,
    acao     text
  );
  delete from diagnostico_audit;

  -- 1. tabelas -------------------------------------------------------------
  select array_agg(nome order by nome) into v_faltando
    from unnest(v_tabelas) as nome
   where to_regclass('public.' || nome) is null;

  v_presentes := array_length(v_tabelas, 1) - coalesce(array_length(v_faltando, 1), 0);

  insert into diagnostico_audit values (
    1, 'tabelas',
    case when v_faltando is null then 'OK' else 'FALHA' end,
    format('%s de %s presentes', v_presentes, array_length(v_tabelas, 1)),
    case when v_faltando is null then null
         else format('faltam: %s — reaplique os passos correspondentes',
                     array_to_string(v_faltando, ', ')) end
  );

  -- 2. funções -------------------------------------------------------------
  select array_agg(nome order by nome) into v_faltando
    from unnest(v_funcoes) as nome
   where not exists (
     select 1 from information_schema.routines
      where routine_schema = 'public' and routine_name = nome
   );

  insert into diagnostico_audit values (
    2, 'funcoes',
    case when v_faltando is null then 'OK' else 'FALHA' end,
    format('%s de %s presentes',
           array_length(v_funcoes,1) - coalesce(array_length(v_faltando,1),0),
           array_length(v_funcoes,1)),
    case when v_faltando is null then null
         else format('faltam: %s', array_to_string(v_faltando, ', ')) end
  );

  -- 3. trigger append-only de events (INV-001 / INV-006) -------------------
  insert into diagnostico_audit
  select 3, 'trigger append-only',
         case when count(*) > 0 then 'OK' else 'FALHA' end,
         case when count(*) > 0 then 'events_append_only ativo'
              else 'ausente: UPDATE e DELETE em events nao estao bloqueados' end,
         case when count(*) > 0 then null
              else 'reaplique 01-multi-tenancy.sql' end
    from pg_trigger where tgname = 'events_append_only' and not tgisinternal;

  -- 4. carga inicial de cobranca — a pergunta que motivou este script ------
  if to_regclass('public.plans') is not null then
    select count(*) into v_planos from public.plans;
  end if;
  if to_regclass('public.billing_settings') is not null then
    select count(*) into v_parametros from public.billing_settings;
  end if;

  insert into diagnostico_audit values (
    4, 'carga inicial (planos)',
    case when v_planos >= 5 and v_parametros >= 1 then 'OK' else 'FALHA' end,
    format('%s planos (esperado 5), %s linha de parametros (esperado 1)',
           v_planos, v_parametros),
    case when v_planos >= 5 and v_parametros >= 1 then null
         else 'reaplique 03-cobranca.sql — e idempotente' end
  );

  -- 5. RLS: plans e billing_settings devem estar DESLIGADOS ----------------
  for v_linha in
    select format('%s=%s(%s policies)', c.relname,
                  case when c.relrowsecurity then 'rls_on' else 'rls_off' end,
                  (select count(*) from pg_policies p
                    where p.schemaname='public' and p.tablename=c.relname))
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r'
       and c.relname in ('plans','billing_settings','tenants','clients','events')
     order by c.relname
  loop
    insert into diagnostico_audit values (5, 'rls', 'INFO', v_linha,
      'plans e billing_settings devem estar rls_off: a calculadora de preco e publica');
  end loop;

  -- 6. escritorio e usuario ------------------------------------------------
  if to_regclass('public.tenants') is null then
    insert into diagnostico_audit values (
      6, 'escritorio', 'FALHA', 'tabela tenants ausente', 'reaplique 01-multi-tenancy.sql');
  elsif v_tem_auth then
    execute $q$
      insert into diagnostico_audit
      select 6, 'escritorio',
             case when count(*) > 0 then 'OK' else 'FALHA' end,
             coalesce(string_agg(format('%s / %s / %s / email_confirmado=%s',
                                        nome, email, papel, confirmado), '; '),
                      'nenhum escritorio com owner'),
             case when count(*) > 0 then null
                  else 'rode 05-bootstrap-escritorio.sql (usuario precisa existir em auth.users)' end
        from (
          select t.name as nome, u.email, m.role as papel,
                 u.email_confirmed_at is not null as confirmado
            from public.tenants t
            join public.memberships m on m.tenant_id = t.id
            join auth.users u on u.id = m.user_id
           where m.role = 'owner'
        ) x
    $q$;
  else
    insert into diagnostico_audit
    select 6, 'escritorio',
           case when count(*) > 0 then 'OK' else 'FALHA' end,
           format('%s owner(s) — schema auth ausente, e-mail nao verificado', count(*)),
           case when count(*) > 0 then null else 'rode 05-bootstrap-escritorio.sql' end
      from public.memberships where role = 'owner';
  end if;

  -- 7. movimento — zeros aqui sao NORMAIS numa instalacao nova -------------
  if to_regclass('public.clients') is not null then
    insert into diagnostico_audit
    select 7, 'movimento', 'INFO',
           format('%s CNPJs, %s competencias, %s eventos, %s documentos',
                  (select count(*) from public.clients),
                  (select count(*) from public.periods),
                  (select count(*) from public.events),
                  (select count(*) from public.documents)),
           'zeros aqui sao esperados antes do primeiro cadastro: nao indicam falha';
  end if;
end
$diag$;

-- Resultado. Esta é a ÚLTIMA instrução de propósito: é a que o editor mostra.
select checagem, estado, detalhe, coalesce(acao, '') as acao
  from diagnostico_audit
 order by ordem, detalhe;
