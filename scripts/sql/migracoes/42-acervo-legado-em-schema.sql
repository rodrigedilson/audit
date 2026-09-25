-- =============================================================================
-- audit — passo 42 de 43: acervo-legado-em-schema
--
-- Acervo legado: copia as 21 tabelas da fase anterior para o schema `legado`,
-- sem alterar os originais em public. Conferir com arquivar-legado.ts conferir-schema.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260927240000_acervo_legado_em_schema.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Acervo legado: segunda cópia, dentro do banco, no schema `legado`
--
-- Vinte e uma tabelas da fase anterior do produto continuam em `public`, com
-- dado de clientes reais, e vão ser migradas para o modelo atual. Antes disso,
-- duas cópias independentes: o arquivo cifrado fora do banco
-- (`scripts/arquivar-legado.ts gerar`) e esta.
--
-- O que esta migration faz, e o que não faz:
-- - COPIA cada tabela legada para `legado.<mesmo nome>`, com colunas, defaults,
--   checks, índices e comentários (`like … including all`). As FKs não vêm: a
--   cópia não depende de `auth.users` nem das outras tabelas.
-- - NÃO altera, move nem apaga nada em `public`. Os originais ficam onde estão.
-- - Tabela que já tem cópia em `legado` não é copiada de novo: rodar duas vezes
--   não duplica linha.
-- - Tudo num bloco só: ou copia todas, ou nenhuma.
-- - Fecha o schema: nem `anon` nem `authenticated` leem a cópia. Só a service
--   role, que é quem migra.
--
-- Depois de aplicar, conferir que a cópia é idêntica à origem:
--   npx tsx scripts/arquivar-legado.ts conferir-schema
-- =============================================================================

create schema if not exists legado;

do $$
declare
  t text;
  colunas text;
  tabelas text[] := array[
    'extracted_invoices', 'extracted_items', 'extracted_taxes', 'extracted_participants',
    'extracted_companies', 'xml_documents', 'xml_document_items', 'xml_import_jobs',
    'sped_parsed_records', 'sped_parsing_jobs', 'cross_reference_results',
    'cross_reference_divergences', 'cross_reference_runs', 'uploaded_files',
    'entity_extraction_jobs', 'document_cache', 'profiles', 'cfops',
    'ai_analyses', 'audits', 'reports'
  ];
begin
  foreach t in array tabelas loop
    -- Fora do Supabase de produção (banco de teste, restauração) a tabela não existe.
    continue when to_regclass(format('public.%I', t)) is null;
    continue when to_regclass(format('legado.%I', t)) is not null;

    execute format('create table legado.%I (like public.%I including all)', t, t);

    -- Coluna gerada não aceita valor no insert; identity aceita com OVERRIDING.
    select string_agg(quote_ident(attname), ', ' order by attnum)
      into colunas
      from pg_attribute
     where attrelid = format('public.%I', t)::regclass
       and attnum > 0 and not attisdropped and attgenerated = '';

    execute format(
      'insert into legado.%I (%s) overriding system value select %s from public.%I',
      t, colunas, colunas, t
    );

    execute format('alter table legado.%I enable row level security', t);
    execute format('comment on table legado.%I is %L', t,
      'Cópia do acervo legado (public.' || t || '), feita em ' || now()::text || '. Não editar.');
  end loop;
end $$;

-- Fechado para as chaves do front. `legado` não entra no `db-schemas` do
-- PostgREST, mas o revoke não depende dessa configuração.
revoke all on schema legado from public;
do $$
begin
  revoke all on schema legado from anon, authenticated;
  revoke all on all tables in schema legado from anon, authenticated;
exception
  when undefined_object then null;
end $$;
