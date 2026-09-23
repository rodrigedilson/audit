-- Remove as sete tabelas órfãs de produção.
--
-- Nenhuma migration as criava e nenhum código as referenciava — conferido por
-- grep nos dois repositórios, incluindo as Edge Functions do Supabase. Vieram de
-- uma feature de "interoperabilidade" planejada e abandonada, provavelmente
-- criada pelo painel. Todas com zero linhas, medidas com `count(*)` e não com a
-- estatística do planejador, que fica velha.
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
