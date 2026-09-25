-- =============================================================================
-- audit — passo 14 de 32: key_id_do_certificado
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260922200000_key_id_do_certificado.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- Rotação da chave mestra do cofre de certificados.
--
-- O PFX é cifrado com AES-256-GCM sob `CERTIFICATE_MASTER_KEY`, e até aqui não
-- havia como saber QUAL chave cifrou cada linha. Sem isso, rotacionar a chave
-- era uma operação de tudo-ou-nada sem forma de conferir o progresso: não dava
-- para responder "quantos certificados ainda estão na chave antiga".
--
-- `key_id` é o identificador público da chave — HMAC de um rótulo fixo sob a
-- própria chave, truncado em 8 bytes. Não guarda nada secreto e não exige que
-- ninguém lembre de incrementar um número de versão, que é o bookkeeping manual
-- que falha justamente na rotação de emergência.
--
-- Nulo significa "cifrado antes desta migração": o script de recifragem trata
-- nulo como chave antiga e preenche o id ao regravar.
alter table public.certificates
  add column if not exists key_id text;

comment on column public.certificates.key_id is
  'Identificador público da chave mestra que cifrou esta linha. Nulo = anterior à rotação versionada. Ver CertificateVault.keyId.';

-- A consulta de progresso da recifragem é "agrupa por key_id", e roda sobre a
-- tabela inteira de todos os tenants — é operação de plataforma, não de cliente.
create index if not exists certificates_key_id_idx on public.certificates (key_id);
