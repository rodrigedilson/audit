-- =============================================================================
-- audit — passo 26 de 41: versao-das-faixas
--
-- Escada de faixas versionada por data: vale a de maior effective_from até
-- hoje, inteira. Agendar uma escada é inserir as faixas com data futura.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260925120000_versao_das_faixas.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Escada de faixas versionada por data
--
-- A chave era `from_clients`, e com ela só cabia uma escada: `effective_from`
-- existia, mas mudar a tabela de desconto era sobrescrever a vigente, sem como
-- anunciar a próxima antes de ela valer.
--
-- Agora a escada é o conjunto de faixas de um mesmo `effective_from`, e vale a
-- de maior data até hoje. A escada inteira muda junto: escolher "a faixa mais
-- recente de cada início" misturaria degraus de duas escadas, e uma escada nova
-- que tira um degrau deixaria o degrau antigo valendo.
--
-- Para agendar uma escada: inserir as faixas completas com o `effective_from`
-- futuro. Ela passa a valer nesse dia, sem deploy.
-- =============================================================================

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.pricing_tiers'::regclass
       and contype = 'p'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (from_clients)'
  ) then
    alter table public.pricing_tiers drop constraint pricing_tiers_pkey;
    alter table public.pricing_tiers add primary key (effective_from, from_clients);
  end if;
end
$$;

comment on column public.pricing_tiers.effective_from is
  'Data em que esta escada passa a valer. Vale a escada de maior effective_from até hoje; agendar é inserir a escada completa com data futura.';
