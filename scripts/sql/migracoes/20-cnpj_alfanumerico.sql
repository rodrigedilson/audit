-- =============================================================================
-- audit — passo 20 de 26: cnpj_alfanumerico
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924140000_cnpj_alfanumerico.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- CNPJ alfanumérico.
--
-- Desde 31/07/2026 a Receita emite CNPJ alfanumérico para inscrições novas
-- (IN RFB 2.229/2024). São as mesmas 14 posições: 12 alfanuméricas e 2 dígitos
-- verificadores, que continuam numéricos. Os CNPJs já existentes não mudaram.
--
-- Cinco tabelas exigiam `^[0-9]{14}$`. Com a restrição antiga, cadastrar uma
-- empresa aberta de agosto em diante devolvia erro de banco — 500 na API, não
-- mensagem de validação. O tipo `char(14)` continua servindo: o que muda é o
-- alfabeto, não o tamanho.
--
-- A restrição nova é mais larga, então nenhuma linha existente passa a violá-la:
-- todo CNPJ numérico de 14 dígitos também casa com o padrão novo.
--
-- O dígito verificador **não** é conferido aqui. Uma restrição de banco que
-- rodasse módulo 11 faria uma linha gravada hoje virar erro de leitura amanhã se
-- a regra mudasse, e o event log é append-only. A conferência fica na fronteira
-- de entrada, em `exigirCnpj`.

do $$
declare
  alvo record;
begin
  for alvo in
    select rel.relname as tabela, con.conname as restricao
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) = 'CHECK ((cnpj ~ ''^[0-9]{14}$''::text))'
  loop
    execute format('alter table public.%I drop constraint %I', alvo.tabela, alvo.restricao);
    execute format(
      'alter table public.%I add constraint %I check (cnpj ~ ''^[0-9A-Z]{12}[0-9]{2}$'')',
      alvo.tabela,
      alvo.restricao
    );
  end loop;
end
$$;
