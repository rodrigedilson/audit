-- =============================================================================
-- audit — passo 21 de 35: chave-alfanumerica
--
-- Chave de acesso com CNPJ alfanumérico: letras nas 12 posições do CNPJ do
-- emitente. Troca toda restrição que ainda exija a chave só de dígitos.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924150000_chave_alfanumerica.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- Chave de acesso com CNPJ alfanumérico.
--
-- A `20260924140000_cnpj_alfanumerico` abriu o CNPJ para letras, mas deixou a
-- chave de acesso de fora. A chave carrega o CNPJ do emitente nas posições 7 a
-- 18, e com ele alfanumérico ela passa a ter letras ali: `[0-9]{6}[0-9A-Z]{12}
-- [0-9]{26}` (NT Conjunta CNPJ Alfanumérico 2025.001). O código já aceitava;
-- `documents.access_key` ainda exigia `^[0-9]{44}$`, e a primeira NF-e de um
-- emitente aberto de agosto em diante virava erro de banco na ingestão — 500,
-- e não rejeição com motivo.
--
-- Troca toda restrição que ainda exija a chave só de dígitos, em qualquer
-- tabela, como a migration do CNPJ fez com o CNPJ. A restrição nova é mais
-- larga: nenhuma linha existente passa a violá-la.

do $$
declare
  alvo record;
begin
  for alvo in
    select rel.relname as tabela, con.conname as restricao, pg_get_constraintdef(con.oid) as definicao
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%^[0-9]{44}$%'
  loop
    execute format('alter table public.%I drop constraint %I', alvo.tabela, alvo.restricao);
    execute format(
      'alter table public.%I add constraint %I %s',
      alvo.tabela,
      alvo.restricao,
      replace(alvo.definicao, '^[0-9]{44}$', '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$')
    );
  end loop;
end
$$;
