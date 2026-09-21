-- =============================================================================
-- audit — reparo e diagnóstico da carga de planos
--
-- Cole no SQL Editor e execute. Idempotente.
--
-- Existe porque a carga de `plans` não entrou e o motivo não é visível de fora:
-- a tabela existe, o RLS dela está desligado e o `anon` consegue consultá-la,
-- mas ela está vazia. Um `insert ... on conflict do nothing` em bloco não diz
-- QUAL linha falhou nem por quê.
--
-- Aqui cada plano entra numa instrução própria, com o erro capturado e relatado
-- individualmente. Se todos passarem, o problema era o bloco; se um falhar, a
-- mensagem diz qual e qual o motivo.
--
-- ATENÇÃO — este script RESTAURA os preços canônicos do briefing
-- (R$ 9 / 9 / 29 / 49 / 89 e mínimo de R$ 150). Ao contrário da migration, que
-- usa `on conflict do nothing`, aqui o `do update` sobrescreve: é um reparo, e
-- reparar significa deixar no estado conhecido. Se você já ajustou preços na
-- tabela `plans`, anote-os antes de rodar — os valores são feitos para ser
-- editados, e este script os volta ao ponto de partida.
-- =============================================================================

do $reparo$
declare
  v_planos jsonb := '[
    {"regime":"mei",              "cents":900,  "features":["saude_cadastro","coleta_dfe","simulador_opcao"]},
    {"regime":"simples_integrado","cents":900,  "features":["saude_cadastro","coleta_dfe","simulador_opcao"]},
    {"regime":"simples_hibrido",  "cents":2900, "features":["saude_cadastro","coleta_dfe","simulador_opcao","apuracao_dual","contra_apuracao","calendario"]},
    {"regime":"lucro_presumido",  "cents":4900, "features":["saude_cadastro","coleta_dfe","simulador_opcao","apuracao_dual","contra_apuracao","calendario","credito_em_risco","dossie_saldo_credor","white_label"]},
    {"regime":"lucro_real",       "cents":8900, "features":["saude_cadastro","coleta_dfe","simulador_opcao","apuracao_dual","contra_apuracao","calendario","credito_em_risco","dossie_saldo_credor","white_label","sped_completo"]}
  ]'::jsonb;
  v_item     jsonb;
  v_regime   text;
  v_antes    int;
  v_depois   int;
  v_inseridos int := 0;
  v_erros    int := 0;
  v_enum     text;
begin
  create temporary table if not exists reparo_planos_log (
    ordem int, etapa text, resultado text, detalhe text
  );
  delete from reparo_planos_log;

  -- 1. o tipo enum tem os valores esperados? -------------------------------
  select string_agg(e.enumlabel, ', ' order by e.enumsortorder) into v_enum
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typname = 'regime';

  insert into reparo_planos_log values (
    1, 'enum public.regime',
    case when v_enum is null then 'FALHA'
         when v_enum like '%mei%' and v_enum like '%lucro_real%' then 'OK'
         else 'ATENCAO' end,
    coalesce(v_enum, 'tipo nao existe — reaplique 01-multi-tenancy.sql')
  );

  if v_enum is null then
    insert into reparo_planos_log values (
      99, 'conclusao', 'FALHA', 'sem o tipo regime nao ha como inserir plano');
    return;
  end if;

  select count(*) into v_antes from public.plans;
  insert into reparo_planos_log values (2, 'planos antes', 'INFO', v_antes::text);

  -- 2. um insert por plano, com o erro capturado individualmente -----------
  for v_item in select * from jsonb_array_elements(v_planos)
  loop
    v_regime := v_item->>'regime';
    begin
      insert into public.plans (regime, monthly_cents, features)
      values (
        (v_item->>'regime')::public.regime,
        (v_item->>'cents')::integer,
        v_item->'features'
      )
      on conflict (regime) do update
        set monthly_cents = excluded.monthly_cents,
            features      = excluded.features,
            updated_at    = now();

      v_inseridos := v_inseridos + 1;
      insert into reparo_planos_log values (3, 'plano ' || v_regime, 'OK', 'gravado');
    exception when others then
      v_erros := v_erros + 1;
      insert into reparo_planos_log values (
        3, 'plano ' || v_regime, 'FALHA', sqlstate || ': ' || sqlerrm);
    end;
  end loop;

  -- 3. parâmetros comerciais ----------------------------------------------
  begin
    insert into public.billing_settings (id) values (true) on conflict (id) do nothing;
    insert into reparo_planos_log
    select 4, 'billing_settings', 'OK',
           format('minimo=%s centavos, trial=%s dias', minimum_cents, trial_days)
      from public.billing_settings where id;
  exception when others then
    insert into reparo_planos_log values (4, 'billing_settings', 'FALHA', sqlstate || ': ' || sqlerrm);
  end;

  -- 4. RLS: precisa estar DESLIGADO para a calculadora publica funcionar ---
  begin
    alter table public.plans            disable row level security;
    alter table public.billing_settings disable row level security;
    insert into reparo_planos_log values (5, 'rls desligado', 'OK', 'plans e billing_settings');
  exception when others then
    insert into reparo_planos_log values (5, 'rls desligado', 'FALHA', sqlerrm);
  end;

  -- 5. leitura pelo papel anon, que e o que a API REST usa -----------------
  begin
    grant select on public.plans, public.billing_settings to anon, authenticated;
    insert into reparo_planos_log values (
      6, 'grant select para anon', 'OK',
      'necessario para a calculadora de preco publica responder pela API REST');
  exception when others then
    -- Num Postgres sem os papeis do Supabase isto falha, e nao e problema.
    insert into reparo_planos_log values (
      6, 'grant select para anon', 'INFO',
      'papeis anon/authenticated nao existem nesta base: ' || sqlerrm);
  end;

  select count(*) into v_depois from public.plans;
  insert into reparo_planos_log values (
    7, 'planos depois',
    case when v_depois >= 5 then 'OK' else 'FALHA' end,
    format('%s planos (%s gravados agora, %s erros)', v_depois, v_inseridos, v_erros)
  );
end
$reparo$;

-- Última instrução de propósito: é a que o SQL Editor do Supabase exibe.
select etapa, resultado, detalhe from reparo_planos_log order by ordem, etapa;
