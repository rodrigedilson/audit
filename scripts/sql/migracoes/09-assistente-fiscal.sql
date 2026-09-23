-- =============================================================================
-- audit — passo 9 de 16: assistente-fiscal
--
-- Conversas do assistente fiscal e a cota mensal por CNPJ, tirada do plano
-- do regime. O assistente é somente leitura: não escreve no log fiscal, e
-- toda afirmação factual dele carrega citação de um `event_seq` deste CNPJ.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921160000_assistant.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 9 — assistente fiscal somente leitura (diferencial #6)
--
-- O contraexemplo a evitar está no briefing: assistente genérico, sem ancoragem
-- nos dados do CNPJ, compete com o ChatGPT e perde. O que este tem de diferente
-- é que **toda afirmação factual carrega citação** de um `event_seq` ou de uma
-- chave de acesso que existe no log deste CNPJ, e a citação é verificável pelo
-- `POST /verify`.
--
-- Três garantias que o schema sustenta:
--
-- 1. O assistente NUNCA escreve no log fiscal. Ele grava só nas tabelas deste
--    módulo — que são conversa, não apuração. Ação recomendada sai em
--    `suggested_intentions` e só o usuário executa.
-- 2. `answerable = false` é resposta de primeira classe. Pergunta que os dados
--    não respondem recebe "não sei, e por quê", nunca uma resposta plausível.
-- 3. O limite mensal vive no plano, por CNPJ, porque é assim que o produto é
--    cobrado. Zero significa "não incluído no plano" — e o usuário recebe isso
--    dito, não uma tela vazia.
-- =============================================================================

alter table public.plans
  add column if not exists assistant_messages_per_month integer not null default 0
    check (assistant_messages_per_month >= 0);

comment on column public.plans.assistant_messages_per_month is
  'Perguntas por CNPJ por mês. Zero = assistente não incluído no plano.';

-- Escalonado junto com o preço. Valores são hipótese de teste, como o resto da
-- tabela de planos: ficam em dado, não em código.
update public.plans set assistant_messages_per_month = case regime
  when 'mei'               then 0
  when 'simples_integrado' then 0
  when 'simples_hibrido'   then 100
  when 'lucro_presumido'   then 300
  when 'lucro_real'        then 1000
end
where assistant_messages_per_month = 0;

update public.plans
   set features = features || '["assistente_fiscal"]'::jsonb
 where assistant_messages_per_month > 0
   and not (features @> '["assistente_fiscal"]'::jsonb);

-- ------------------------------------------------------------------ conversas
create table if not exists public.assistant_threads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  cnpj        char(14) not null,
  title       text not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists assistant_threads_scope_idx
  on public.assistant_threads (tenant_id, cnpj, created_at desc);

alter table public.assistant_threads enable row level security;
drop policy if exists assistant_threads_select_own on public.assistant_threads;
create policy assistant_threads_select_own on public.assistant_threads
  for select using (public.is_member_of(tenant_id));

create table if not exists public.assistant_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.assistant_threads (id) on delete cascade,
  tenant_id   uuid not null,
  cnpj        char(14) not null,

  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  -- Quem perguntou. Um escritório tem vários contadores, e conversa sem autor
  -- não diz de quem foi a pergunta nem quem viu a resposta.
  created_by  uuid,

  -- Preenchidos só na resposta do assistente.
  intent      text,
  /**
   * Camada do roteamento que atendeu (ADR-026).
   *
   * 1 = determinístico, sem modelo nenhum: a resposta sai de consulta ao banco.
   * 2 e 3 = modelo de linguagem. A camada fica gravada porque a diferença
   * importa: resposta de camada 1 é reproduzível, resposta de modelo não é.
   */
  tier        smallint check (tier between 1 and 3),
  confidence  text check (confidence in ('high', 'medium', 'low')),

  /**
   * `false` quando os dados não respondem a pergunta.
   *
   * É resposta de primeira classe, e não erro: "não sei, e por quê" é
   * verdadeiro, enquanto uma resposta plausível sem lastro é o modo de falha
   * que este produto não pode ter.
   */
  answerable  boolean,

  /** Afirmações com as citações que as sustentam. Ver `grounding.ts`. */
  claims      jsonb not null default '[]'::jsonb,
  /** Intenções sugeridas. O assistente NÃO as executa. */
  suggested   jsonb not null default '[]'::jsonb,

  created_at  timestamptz not null default now()
);

create index if not exists assistant_messages_thread_idx
  on public.assistant_messages (thread_id, created_at);

-- Serve a contagem do limite mensal por CNPJ.
create index if not exists assistant_messages_uso_idx
  on public.assistant_messages (tenant_id, cnpj, role, created_at);

alter table public.assistant_messages enable row level security;
drop policy if exists assistant_messages_select_own on public.assistant_messages;
create policy assistant_messages_select_own on public.assistant_messages
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------------------------ uso
--
-- Contado a partir das próprias mensagens, sem tabela de contador: um contador
-- separado pode divergir da lista que ele conta, e seria o número que decide
-- cobrar ou recusar.
create or replace function public.assistant_usage(
  p_tenant uuid,
  p_cnpj char(14),
  p_month char(7) default to_char(now(), 'YYYY-MM')
)
returns table (
  used      integer,
  allowance integer,
  remaining integer
)
language sql
stable
security definer
set search_path = public
as $$
  with consumo as (
    select count(*)::integer as total
      from public.assistant_messages m
     where m.tenant_id = p_tenant
       and m.cnpj = p_cnpj
       and m.role = 'user'
       and to_char(m.created_at, 'YYYY-MM') = p_month
  ),
  limite as (
    select coalesce(p.assistant_messages_per_month, 0) as total
      from public.clients c
      join public.plans p on p.regime = c.regime
     where c.tenant_id = p_tenant and c.cnpj = p_cnpj
  )
  select consumo.total,
         coalesce(limite.total, 0),
         greatest(coalesce(limite.total, 0) - consumo.total, 0)
    from consumo left join limite on true;
$$;

comment on function public.assistant_usage is
  'Uso e limite mensal do assistente por CNPJ. O limite vem do plano do regime '
  'do cliente, porque é por CNPJ ativo que o produto é cobrado.';
