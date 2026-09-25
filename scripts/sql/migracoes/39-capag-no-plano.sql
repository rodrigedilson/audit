-- =============================================================================
-- audit — passo 39 de 43: capag-no-plano
--
-- CAPAG presumida nos planos Simples híbrido, Lucro Presumido e Lucro Real,
-- os que já incluem o assistente fiscal.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927210000_capag_no_plano.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- CAPAG presumida nos planos
--
-- A CAPAG nasceu sem feature de plano. Entra nos planos que já incluem o
-- assistente fiscal (Simples híbrido, Lucro Presumido, Lucro Real), pelos
-- mesmos dois motivos:
--
-- - cada demonstrativo é uma chamada ao modelo de linguagem, e esses são os
--   planos que já comportam esse custo; o de R$ 9 não comporta;
-- - a CAPAG serve para negociar transação com a PGFN, trabalho que aparece em
--   empresa com operação e dívida relevantes. O MEI costuma negociar por edital
--   simplificado, que não pede contestação de CAPAG.
--
-- É decisão comercial, e reversível aqui mesmo: tirar a chave de `features`
-- fecha a rota para o regime (403 feature_not_in_plan).
-- =============================================================================

update public.plans
   set features = features || '["capag"]'::jsonb
 where regime in ('simples_hibrido', 'lucro_presumido', 'lucro_real')
   and not features ? 'capag';

insert into public.plan_features (key, label, description, sort_order) values
  ('capag', 'CAPAG presumida',
   'Lê o demonstrativo de capacidade de pagamento do REGULARIZE, confere cada número no próprio documento e refaz a conta.', 75)
on conflict (key) do update
   set label = excluded.label, description = excluded.description,
       sort_order = excluded.sort_order, updated_at = now();
