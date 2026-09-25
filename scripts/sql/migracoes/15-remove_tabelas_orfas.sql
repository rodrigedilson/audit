-- =============================================================================
-- audit — passo 15 de 43: remove_tabelas_orfas
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260922210000_remove_tabelas_orfas.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- Remove as sete tabelas órfãs de produção.
--
-- Nenhuma migration **deste repositório** as criava e nenhum código as
-- referenciava — conferido por grep nos dois repositórios, incluindo as Edge
-- Functions. Todas com zero linhas, medidas com `count(*)` e não com a
-- estatística do planejador, que fica velha.
--
-- **De onde vieram:** da branch `feature/backend-implementation` do
-- `sped-genius-hub`, arquivo
-- `supabase/migrations/20260301000001_create_interop_tables.sql`. É uma feature
-- de interoperabilidade entre grafos de empresas — análise inter-CNPJ, detecção
-- de padrões suspeitos, motor de regras customizadas, export em PDF: 28
-- arquivos e ~8.500 linhas, última atividade em 2026-03-02. A migration foi
-- aplicada em produção e a branch nunca foi mergeada.
--
-- Por isso remover é seguro **e** reversível no sentido que importa: se a
-- feature for retomada, é a migration dela que recria as tabelas, com o schema
-- que o código espera. O que não podia continuar é produção carregando sete
-- tabelas que nenhuma migration do repositório explica.
--
-- Elas formam uma hierarquia, e não sete tabelas soltas:
--
--   analysis_groups  ←FK←  interop_sessions  ←FK←  alerts, cross_notes,
--                                                  common_participants,
--                                                  cfop_pairs
--   interop_custom_rules (sem FK em nenhuma direção)
--
-- Por isso a ordem abaixo: quem é apontado sai depois de quem aponta. `cascade`
-- resolveria em uma linha e apagaria em silêncio o que esta migration existe
-- para nomear uma por uma.
--
-- A guarda antes do drop não é cerimônia: entre o levantamento e o deploy alguém
-- pode ter escrito nelas, e nesse caso a pergunta deixa de ser "apagar" e passa
-- a ser "de onde veio isso". Ver `scripts/tabelas-mortas.ts`, que produziu esta
-- lista.
do $$
declare
  alvo text;
  linhas bigint;
  ocupadas text[] := '{}';
begin
  foreach alvo in array array[
    'interop_alerts',
    'interop_cfop_pairs',
    'interop_common_participants',
    'interop_cross_notes',
    'interop_custom_rules',
    'interop_sessions',
    'analysis_groups'
  ]
  loop
    if to_regclass('public.' || alvo) is null then
      continue;
    end if;

    execute format('select count(*) from public.%I', alvo) into linhas;

    if linhas > 0 then
      ocupadas := ocupadas || format('%s (%s linha(s))', alvo, linhas);
    end if;
  end loop;

  if array_length(ocupadas, 1) > 0 then
    raise exception
      'Tabelas orfas deixaram de estar vazias: %. Alguem escreveu nelas depois do levantamento — investigue antes de remover.',
      array_to_string(ocupadas, ', ');
  end if;
end $$;

drop table if exists public.interop_alerts;
drop table if exists public.interop_cfop_pairs;
drop table if exists public.interop_common_participants;
drop table if exists public.interop_cross_notes;
drop table if exists public.interop_custom_rules;
drop table if exists public.interop_sessions;
drop table if exists public.analysis_groups;
