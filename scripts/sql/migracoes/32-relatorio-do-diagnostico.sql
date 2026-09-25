-- =============================================================================
-- audit — passo 32 de 40: relatorio-do-diagnostico
--
-- Relatório do diagnóstico público por e-mail: o resumo fica cifrado por até
-- 24h, só para o envio, e o link de remoção do e-mail (LGPD).
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260926160000_relatorio_do_diagnostico.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Relatório do diagnóstico público por e-mail
--
-- O diagnóstico prometia "receba o relatório por e-mail" e só gravava o lead.
-- Para enviar depois que o visitante vê o resultado, o relatório fica guardado
-- CIFRADO por no máximo 24h (chave própria, `REPORT_ENCRYPTION_KEY`) e é apagado
-- assim que sai. Os XMLs continuam sem ser guardados; o que fica por 24h é o
-- resumo que a tela já mostrou.
-- =============================================================================

alter table public.readiness_reports
  add column if not exists report_ciphertext  text,
  add column if not exists report_expires_at  timestamptz,
  add column if not exists email_sent_at      timestamptz,
  add column if not exists email_error        text,
  -- sha256 do token do link "apagar meu e-mail" (LGPD). O token não é guardado.
  add column if not exists forget_token_hash  char(64);

alter table public.readiness_reports
  drop constraint if exists readiness_relatorio_com_prazo;
alter table public.readiness_reports
  add constraint readiness_relatorio_com_prazo
    check (report_ciphertext is null or report_expires_at is not null);

create index if not exists readiness_reports_expira_idx
  on public.readiness_reports (report_expires_at)
  where report_ciphertext is not null;

create unique index if not exists readiness_reports_forget_idx
  on public.readiness_reports (forget_token_hash)
  where forget_token_hash is not null;

comment on table public.readiness_reports is
  'Métrica agregada do diagnóstico público. O resumo do relatório fica cifrado por até 24h, só para o envio por e-mail.';
