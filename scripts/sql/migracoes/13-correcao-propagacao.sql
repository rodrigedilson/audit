-- =============================================================================
-- audit — passo 13 de 42: correcao-propagacao
--
-- Correção: a propagação ignorava o item nunca classificado, e o número que
-- sustenta o diferencial #1 lia zero exatamente no estado em que mais
-- importa — o do escritório que ingeriu e ainda não classificou nada.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260922100000_propagacao_de_item_nao_classificado.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Correção: a propagação ignorava o item nunca classificado
--
-- `item_propagation()` partia de `item_classifications`. Item que nunca foi
-- classificado não tem linha lá, então **não aparecia na propagação** — e o
-- resultado, medido em dado real, foi este:
--
--   474 itens no catálogo · 0 classificados · item_propagation() devolveu 0 linhas
--   os mesmos 474 itens aparecem em 578 linhas de documento, R$ 1.420.745,30
--
-- Ou seja: a tela dizia "474 itens com aviso" e, ao lado, "0 notas afetadas,
-- R$ 0,00 em jogo". O número que sustenta o diferencial #1 — quantas notas já
-- emitidas carregam a classificação do item — lia zero exatamente no estado em
-- que ele mais importa, que é o do escritório que acabou de ingerir e ainda não
-- classificou nada.
--
-- A função passa a partir de `items`, o catálogo, com `left join` na
-- classificação vigente. Item sem classificação vem com `health` nulo, e isso é
-- informação: não é "ok", é "nunca conferido".
--
-- **Consequência para quem chama:** `where health <> 'ok'` deixa de servir,
-- porque `null <> 'ok'` é nulo e não verdadeiro — filtraria fora justamente o
-- caso corrigido. Os chamadores usam `is distinct from`.
-- =============================================================================

create or replace function public.item_propagation(
  p_tenant_id uuid,
  p_cnpj      char(14)
) returns table (
  item_id                      text,
  health                       text,
  outbound_documents_affected  bigint,
  inbound_documents_affected   bigint,
  total_cents_affected         bigint
) language sql stable as $$
  with vigente as (
    select distinct on (c.item_id) c.item_id, c.health
      from public.item_classifications c
     where c.tenant_id = p_tenant_id and c.cnpj = p_cnpj
     order by c.item_id, c.effective_from desc
  )
  select i.item_id,
         -- Nulo quando nunca classificado. Quem lê decide o que fazer com isso,
         -- e é por isso que não vira 'ok' nem 'warning' aqui dentro.
         v.health,
         count(*) filter (where d.direction = 'outbound') as outbound_documents_affected,
         count(*) filter (where d.direction = 'inbound')  as inbound_documents_affected,
         coalesce(sum(di.total_cents), 0)                 as total_cents_affected
    from public.items i
    left join vigente v on v.item_id = i.item_id
    left join public.document_items di
      on di.tenant_id = p_tenant_id and di.cnpj = p_cnpj and di.code = i.item_id
    left join public.documents d
      on d.tenant_id = di.tenant_id and d.cnpj = di.cnpj and d.access_key = di.access_key
   where i.tenant_id = p_tenant_id and i.cnpj = p_cnpj
   group by i.item_id, v.health;
$$;

comment on function public.item_propagation is
  'Quantas notas já emitidas carregam a classificação de cada item do catálogo. '
  'Parte de `items`, não de `item_classifications`: item nunca classificado vem '
  'com `health` nulo e É contado, porque é ele que representa o trabalho que falta.';
