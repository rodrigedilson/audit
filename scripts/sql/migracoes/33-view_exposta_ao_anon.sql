-- =============================================================================
-- audit — passo 33 de 35: view_exposta_ao_anon
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927100000_view_exposta_ao_anon.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- Fecha `sped_invoices_for_crossref`, que servia dado fiscal à chave anon.
--
-- A chave anon é **pública por construção**: vai no pacote do frontend e
-- qualquer pessoa a lê. O que a protege é a RLS de cada tabela.
--
-- Esta é uma **view**, e view não tem RLS. Pior: no Postgres ela roda por padrão
-- com o privilégio de quem a definiu (`security_invoker = off`), então atravessa
-- a RLS das tabelas de baixo. O resultado, conferido em produção em 25/09/2026:
-- `GET /rest/v1/sped_invoices_for_crossref` com a chave anon devolvia `200` e
-- 192 notas reais, com CNPJ do emitente, número, série e data de emissão.
--
-- A view é resíduo da fase anterior do produto. Nenhum código a consulta — nem
-- a API, nem os scripts, nem o frontend.
--
-- Não é `drop` de propósito: a definição é a única cópia que existe, e apagá-la
-- para fechar um furo de permissão seria trocar um problema por outro. As duas
-- linhas abaixo fecham igual e são reversíveis.

-- Condicional porque a view não é criada por migration nenhuma: ela existe só em
-- produção, herdada da fase anterior. Num banco novo — o de teste, o de um
-- desenvolvedor — ela não existe, e um `revoke` direto abortaria a migração com
-- `relation does not exist`.
do $$
begin
  if to_regclass('public.sped_invoices_for_crossref') is null then
    return;
  end if;

  revoke all on public.sped_invoices_for_crossref from anon, authenticated;

  -- Cinto e suspensório: se alguém reconceder o `select` um dia, a view passa a
  -- respeitar a RLS das tabelas de origem em vez de atravessá-la.
  execute 'alter view public.sped_invoices_for_crossref set (security_invoker = on)';
end
$$;
