-- =============================================================================
-- audit — passo 34 de 41: indices-financeiros
--
-- Series de indice financeiro versionadas por competencia, para a correcao
-- monetaria dizer qual indice, qual periodo e qual fonte. Nascem vazias e
-- nao conferidas: indice errado num laudo e pior que laudo sem indice.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927120000_indices_financeiros.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Séries de índice financeiro, versionadas por competência.
--
-- Toda correção monetária num laudo precisa dizer **qual índice, qual período e
-- qual fonte**. Sem isso o número não é conferível, e a parte contrária pede
-- esclarecimento antes de discutir o mérito. As séries ficam em tabela, e não
-- em código, porque cada mês acrescenta um ponto — e código não é lugar de dado
-- que muda mensalmente.
--
-- As duas tabelas **nascem vazias**, e o catálogo nasce **não conferido**.
--
-- IPCA, INPC, IGP-M, TR e SELIC têm publicação mensal oficial que ninguém
-- carregou ainda. Índice errado numa memória de cálculo que vai ao juízo é pior
-- do que memória ausente: o laudo pede um valor que não se sustenta, e quem
-- perde credibilidade é quem assinou. Enquanto a série não cobrir o intervalo,
-- o cálculo devolve nulo com o motivo — nunca fator 1, que se leria como "não
-- houve inflação no período".
--
-- **Por que globais, sem `tenant_id`:** um índice não pertence a um escritório.
-- É dado público, igual para todo mundo, como `evaluation_criteria` e
-- `fiscal_codes`. RLS desligada e `grant select` para leitura; escrita é da
-- service role.
--
-- **Por que a variação é fração, e não percentual:** a fonte publica "0,42%", e
-- guardar `0.42` faria a correção de um ano render 4.200%. É um erro que passa
-- despercebido num teste de um mês só e aparece no laudo. `numeric(12,8)` com o
-- valor `0.00420000` deixa a unidade explícita na própria coluna.
-- =============================================================================

create table if not exists public.financial_indices (
  index_id     text primary key,
  name         text not null check (length(btrim(name)) > 0),
  -- Quem publica: IBGE, FGV, BCB, TJSP.
  source       text not null check (length(btrim(source)) > 0),
  -- Conferida na fonte oficial? Enquanto `false`, o cálculo não afirma.
  verified     boolean not null default false,
  source_ref   text,
  verified_by  uuid,
  verified_at  timestamptz,

  -- Mesma regra dos critérios de avaliação: conferido exige apontar o texto.
  constraint indices_conferidos_tem_fonte check (
    not verified or (source_ref is not null and length(btrim(source_ref)) > 0)
  )
);

/**
 * O catálogo das séries que o produto sabe aplicar, todas NÃO conferidas.
 *
 * Nascer não conferido é melhor do que nascer vazio: o escritório vê quais
 * séries precisa carregar, em vez de encontrar uma tabela vazia sem saber o que
 * falta. O ponto mensal é que não vem — e sem ponto, não há fator.
 */
insert into public.financial_indices (index_id, name, source, verified)
values
  ('ipca',  'Índice Nacional de Preços ao Consumidor Amplo', 'IBGE', false),
  ('inpc',  'Índice Nacional de Preços ao Consumidor',       'IBGE', false),
  ('igpm',  'Índice Geral de Preços do Mercado',             'FGV',  false),
  ('tr',    'Taxa Referencial',                              'BCB',  false),
  ('selic', 'Taxa SELIC acumulada no mês',                   'BCB',  false)
on conflict (index_id) do nothing;

create table if not exists public.financial_index_points (
  index_id    text not null references public.financial_indices (index_id) on delete cascade,
  period      char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  -- Fração, não percentual: 0,42% é `0.00420000`.
  variation   numeric(12,8) not null,
  -- Número-índice, quando a fonte publica. Informativo, não entra no fator.
  level       numeric(18,8),
  -- Identificação do dado conferido: URL, número da tabela, data da coleta.
  source_ref  text,

  loaded_at   timestamptz not null default now(),

  primary key (index_id, period)
);

/** Busca por intervalo: é sempre "desta competência até aquela". */
create index if not exists index_points_intervalo_idx
  on public.financial_index_points (index_id, period);

alter table public.financial_indices      disable row level security;
alter table public.financial_index_points disable row level security;

/**
 * Leitura só para `authenticated`, e **não** para `anon`.
 *
 * O dado é público na origem — IBGE e BCB publicam —, e essa seria justificativa
 * suficiente para liberar. Mas não há tela pública que precise das séries: quem
 * as consome é o módulo de perícia, atrás de autenticação. Liberar ao `anon`
 * acrescentaria superfície sem acrescentar função.
 *
 * A chave `anon` é pública por construção, e o incidente de 25/09/2026 mostrou
 * o custo de expor o que não precisa estar exposto. A regra que fica: objeto
 * novo só ganha `anon` quando uma tela pública o exige, e a exigência vai
 * escrita aqui.
 */
do $$
begin
  grant select on public.financial_indices      to authenticated;
  grant select on public.financial_index_points to authenticated;
exception
  when undefined_object then null;
end $$;
