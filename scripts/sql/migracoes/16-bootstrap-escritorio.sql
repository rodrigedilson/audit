-- =============================================================================
-- audit — passo 16 de 16: bootstrap do escritório
--
-- Vincula seu usuário do Supabase Auth a um escritório, como owner.
-- EDITE as duas linhas marcadas com CONFIGURE antes de executar.
--
-- ARQUIVO GERADO por `npm run sql:bundle`.
-- Não edite aqui.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- PARTE 2 — bootstrap do escritório
--
-- Vincula um usuário do Supabase Auth a um escritório, como owner. Sem isso a
-- API responde 403 em tudo: o tenant é resolvido pela tabela `memberships`, e
-- nunca por um claim do token — um claim fica velho quando alguém sai do
-- escritório, e a sessão antiga continuaria valendo.
-- =============================================================================

do $bootstrap$
declare
  -- ┌──────────────────────────── CONFIGURE ────────────────────────────┐
  v_email       text := 'voce@seudominio.com.br';
  v_escritorio  text := 'Meu Escritório de Contabilidade';
  -- └───────────────────────────────────────────────────────────────────┘

  v_user_id     uuid;
  v_confirmado  boolean;
  v_tenant_id   uuid;
  v_existente   text;
begin
  select id, email_confirmed_at is not null
    into v_user_id, v_confirmado
    from auth.users
   where lower(email) = lower(v_email);

  if v_user_id is null then
    raise exception using
      message = format('Nenhum usuário com e-mail %L em auth.users.', v_email),
      hint = 'Crie em Authentication → Users → Add user, marcando "Auto Confirm User".';
  end if;

  if not v_confirmado then
    raise warning 'E-mail % ainda não confirmado: o login vai falhar até confirmar.', v_email;
  end if;

  select t.name into v_existente
    from memberships m join tenants t on t.id = m.tenant_id
   where m.user_id = v_user_id
   limit 1;

  if v_existente is not null then
    raise notice 'Usuário já pertence a %. Nada a criar.', v_existente;
    return;
  end if;

  insert into tenants (name) values (v_escritorio) returning id into v_tenant_id;
  insert into memberships (tenant_id, user_id, role)
       values (v_tenant_id, v_user_id, 'owner');

  raise notice 'Escritório % criado; % vinculado como owner.', v_escritorio, v_email;
end
$bootstrap$;

-- =============================================================================
-- PARTE 3 — conferência
--
-- Deve devolver uma linha com o seu e-mail e o papel owner.
-- =============================================================================

select
  t.id            as tenant_id,
  t.name          as escritorio,
  t.plan          as plano,
  u.email         as usuario,
  m.role          as papel,
  (select count(*) from plans)   as planos_carregados,
  (select minimum_cents from billing_settings where id) as minimo_centavos
from memberships m
join tenants t on t.id = m.tenant_id
join auth.users u on u.id = m.user_id
order by m.created_at desc
limit 5;
