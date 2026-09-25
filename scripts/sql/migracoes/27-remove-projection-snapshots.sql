-- =============================================================================
-- audit — passo 27 de 33: remove-projection-snapshots
--
-- Remove a tabela de snapshot da projeção, órfã desde a primeira migration:
-- nada nunca escreveu nela, e um cache vazio afirma um cache que não existe.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260925130000_remove_projection_snapshots.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Remove `projection_snapshots`, órfã desde a primeira migration.
--
-- Ela nasceu em `20260918120000_multi_tenancy.sql` com um propósito declarado no
-- próprio comentário: *"Elimina o replay integral a cada intenção. O snapshot
-- pode divergir do log, então guarda last_event_seq e o hash: POST /verify
-- sempre reprojeta do zero."*
--
-- Esse cache nunca foi escrito. Conferido por grep em `src/`, `tests/` e
-- `scripts/`: a única menção é a lista de tabelas esperadas do
-- `environment-doctor`, que apenas confere que ela existe. Nenhuma linha lê,
-- nenhuma escreve, e `FiscalOrchestratorService` reprojeta o log inteiro a cada
-- intenção — que é o custo que a tabela existia para evitar.
--
-- **Por que sair, e não ficar esperando uso:** uma tabela vazia com nome de
-- cache afirma que existe um cache. Quem lê o schema para entender o sistema
-- conclui que a projeção é materializada, e ela não é. Esse é o mesmo defeito
-- que `20260922210000_remove_tabelas_orfas.sql` removeu em sete tabelas — a
-- diferença é que estas eram de outro repositório, e esta é nossa.
--
-- **O que muda se o cache for mesmo necessário um dia:** nada se perde. A
-- migration que o introduzir vai desenhá-lo com o shape que o código exigir, e
-- hoje já se sabe que o shape atual não serviria para o caso mais provável.
-- Congelar a projeção canônica de uma competência confirmada — para que um
-- `projection_hash` gravado continue verificável depois que a forma da projeção
-- evoluir — precisa de chave por **competência** e da `schema_version` em que o
-- hash foi gerado. A chave aqui é `(tenant_id, cnpj)`, um snapshot por CNPJ, e
-- não há coluna de versão. Ou seja: manter a tabela não adiantaria o trabalho,
-- só manteria a promessa falsa.
--
-- A guarda antes do drop segue o precedente da remoção anterior: entre o
-- levantamento e o deploy alguém pode ter passado a escrever nela, e nesse caso
-- a pergunta deixa de ser "apagar" e passa a ser "quem escreveu".
-- =============================================================================

do $$
declare
  linhas bigint;
begin
  if to_regclass('public.projection_snapshots') is null then
    raise notice 'projection_snapshots já não existe; nada a fazer.';
    return;
  end if;

  execute 'select count(*) from public.projection_snapshots' into linhas;

  if linhas > 0 then
    raise exception
      'projection_snapshots tem % linha(s) e não será removida. '
      'Ela estava órfã no levantamento: descubra quem passou a escrever nela '
      'antes de decidir.', linhas;
  end if;

  drop table public.projection_snapshots;
  raise notice 'projection_snapshots removida (estava vazia e sem leitor).';
end $$;
