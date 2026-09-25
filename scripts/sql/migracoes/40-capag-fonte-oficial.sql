-- =============================================================================
-- audit — passo 40 de 42: capag-fonte-oficial
--
-- CAPAG presumida: a fórmula da página oficial da PGFN pode ficar conferida;
-- a de doutrina continua como referência, nunca conferida.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927220000_capag_fonte_oficial.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- CAPAG presumida: a fórmula oficial da PGFN pode ser conferida
--
-- A migration da CAPAG partiu de que a fórmula não estava em texto público, e
-- por isso proibiu `verified = true` na referência. Estava errado: a PGFN
-- publica as três fórmulas (pessoa física, PJ fora do Simples e PJ do Simples)
-- na página "Consultar a Capacidade de Pagamento", no gov.br, com base na
-- Portaria PGFN 6.757/2022.
--
-- A regra passa a ser:
-- - `oficial_pgfn`: a fórmula lida da página da PGFN, com todo coeficiente
--   achado literal na página baixada pelo código. Pode ficar conferida.
-- - `doutrina`: qualquer outra fonte. Continua registrada como referência, e
--   nunca conferida.
-- =============================================================================

alter table public.capag_reference_formulas
  drop constraint if exists capag_referencia_nunca_conferida;

alter table public.capag_reference_formulas
  drop constraint if exists capag_reference_formulas_source_kind_check;

alter table public.capag_reference_formulas
  add constraint capag_reference_formulas_source_kind_check
  check (source_kind in ('doutrina', 'oficial_pgfn'));

-- Conferida só a oficial, e só com ao menos uma fonte citada.
alter table public.capag_reference_formulas
  drop constraint if exists capag_referencia_conferida_so_oficial;

alter table public.capag_reference_formulas
  add constraint capag_referencia_conferida_so_oficial
  check (not verified or (source_kind = 'oficial_pgfn' and jsonb_array_length(sources) > 0));
