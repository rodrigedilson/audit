-- =============================================================================
-- audit — passo 37 de 40: request_id_na_trilha
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927180000_request_id_na_trilha.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- `request_id` na trilha de segurança: o que liga a trilha ao log.
--
-- Sem ele, uma linha da trilha diz "403 em /v1/clients" e não há como achar a
-- linha de log correspondente — nem o cliente tem um número para citar ao
-- relatar um problema. A trilha respondia "o quê" e o log respondia "por quê",
-- e os dois não se encontravam.
--
-- O mesmo id vai no cabeçalho `x-request-id` da resposta e em toda linha de log
-- da requisição.
--
-- Não é `uuid` de propósito: quando o proxy manda um `x-request-id`, o valor é
-- dele e pode ter qualquer formato. Recusar o id do proxy para caber num tipo
-- quebraria a correlação justamente com quem está na frente.

alter table public.security_events
  add column if not exists request_id text;

create index if not exists security_events_request_idx
  on public.security_events (request_id) where request_id is not null;

comment on column public.security_events.request_id is
  'Mesmo id do cabeçalho x-request-id e das linhas de log da requisição.';
