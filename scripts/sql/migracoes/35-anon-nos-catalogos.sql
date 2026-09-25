-- =============================================================================
-- audit — passo 35 de 38: anon-nos-catalogos
--
-- Fecha a chave anon os quatro catalogos globais. Dado sem tenant_id nao e
-- o mesmo que dado que precisa ser publico: nenhuma tela publica os
-- consome, e quem os le e a nossa API, autenticada.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927140000_anon_nos_catalogos.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Fecha à chave anon os quatro catálogos globais.
--
-- `tax_rules`, `audit_trails`, `deadline_rules` e `evaluation_criteria` ganharam
-- `grant select ... to anon, authenticated` nas migrations que as criaram. A
-- justificativa de então era razoável: são catálogos, não têm `tenant_id` e não
-- guardam dado de cliente — regra fiscal, definição de trilha, prazo normativo,
-- citação de norma.
--
-- **O que mudou:** a checagem de exposição ao `anon` passou a olhar de fora, e
-- reprova num banco corretamente migrado. Ela está certa, e a exposição é que
-- não se justifica.
--
-- Dado sem `tenant_id` não é o mesmo que dado que precisa ser público. Nenhuma
-- tela pública consome esses quatro: as rotas públicas são login, health,
-- planos, calculadora de preço e o diagnóstico da reforma. Quem lê os catálogos
-- é a nossa API, autenticada, com a service role. O `grant` ao `anon` abria
-- leitura direta via PostgREST para qualquer pessoa na internet, sem
-- acrescentar função nenhuma.
--
-- Dois deles hoje estão vazios por contrato — `tax_rules` e `deadline_rules` —
-- e por isso a checagem ainda não os acusa: ela testa o que **devolve linha**.
-- Fechar os quatro de uma vez evita a surpresa de a checagem passar a reprovar
-- no dia em que alguém carregar as regras.
--
-- `authenticated` permanece: é leitura de quem já entrou, e a diferença entre
-- os dois papéis é exatamente o ponto.
--
-- A regra que fica, e que a migration dos índices financeiros já seguiu: objeto
-- novo só ganha `anon` quando uma tela pública o exige, e a exigência vai
-- escrita na própria migration.
-- =============================================================================

do $$
declare
  alvo text;
begin
  foreach alvo in array array[
    'tax_rules',
    'audit_trails',
    'deadline_rules',
    'evaluation_criteria'
  ]
  loop
    if to_regclass('public.' || alvo) is null then
      raise notice 'public.% não existe; nada a revogar.', alvo;
      continue;
    end if;

    execute format('revoke all on public.%I from anon', alvo);
    raise notice 'public.% fechada para anon; authenticated preservado.', alvo;
  end loop;
exception
  -- Ambiente local não tem os papéis do Supabase, e isso não é erro de schema.
  when undefined_object then
    raise notice 'Papel anon não existe neste banco; nada a revogar.';
end $$;
