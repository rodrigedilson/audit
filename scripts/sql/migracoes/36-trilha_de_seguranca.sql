-- =============================================================================
-- audit — passo 36 de 42: trilha_de_seguranca
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927150000_trilha_de_seguranca.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- Trilha de segurança: o log operacional que o event log não cobre.
--
-- O event log é append-only e responde "quem mudou este número fiscal". Não
-- responde "quem tentou entrar e falhou", "quem foi barrado por papel" nem "de
-- onde veio a rajada" — e é isso que uma investigação de incidente pergunta
-- primeiro. Hoje essas linhas existem só na saída padrão, que o provedor guarda
-- por pouco tempo: uma apuração de seis meses atrás não teria material.
--
-- Fica **fora** do event log de propósito. O log é trilha de defesa perante o
-- Fisco; misturar tentativa de login nele poluiria a prova com operação.

create table if not exists public.security_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),

  -- `login_ok`, `login_falhou`, `nao_autenticado`, `sem_permissao`, `limite`.
  kind        text not null,

  -- Nulos quando o evento é anterior à identificação — que é o caso mais
  -- interessante para investigar.
  user_id     uuid,
  tenant_id   uuid,
  cnpj        char(14),

  method      text,
  route       text,

  -- HMAC do IP, nunca o IP. Serve para ligar tentativas entre si sem guardar
  -- dado pessoal; o domínio do HMAC é próprio, então este hash não é
  -- comparável com o do diagnóstico público — ligar os dois seria uma decisão,
  -- não um efeito colateral.
  ip_hash     char(64),
  user_agent  text,

  -- HMAC do e-mail tentado, nunca o e-mail. Uma tentativa de login falha carrega
  -- o endereço de alguém que pode nem ser usuário — digitação errada, varredura
  -- de lista. Guardar o hash responde "quantas tentativas contra a mesma conta"
  -- sem colecionar endereço de terceiro.
  subject_hash char(64),

  detail      text
);

create index if not exists security_events_at_idx
  on public.security_events (at desc);

-- As duas perguntas de uma investigação: "o que este IP fez" e "o que
-- aconteceu com este usuário".
create index if not exists security_events_ip_idx
  on public.security_events (ip_hash, at desc) where ip_hash is not null;
create index if not exists security_events_user_idx
  on public.security_events (user_id, at desc) where user_id is not null;
create index if not exists security_events_subject_idx
  on public.security_events (subject_hash, at desc) where subject_hash is not null;

alter table public.security_events enable row level security;

-- Sem policy de propósito: ninguém lê pela API. A leitura é investigação, e se
-- faz com o papel de serviço. Uma policy por escritório convidaria a expor a
-- trilha na tela, e trilha de segurança visível ao investigado perde a função.

comment on table public.security_events is
  'Trilha operacional de autenticação, autorização e limite. Fora do event log: '
  'aquele é prova fiscal, este é investigação de incidente.';
