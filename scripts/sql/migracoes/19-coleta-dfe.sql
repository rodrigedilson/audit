-- =============================================================================
-- audit — passo 19 de 35: coleta-dfe
--
-- Coleta de DF-e na SEFAZ (ADR-006): formato da credencial no cofre, fila de
-- jobs, estado do NSU por CNPJ, resumos para ciência e NF-e baixadas que
-- esperam a competência abrir.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924130000_coleta_dfe.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Coleta de DF-e na SEFAZ (ADR-006)
--
-- Distribuição por NSU e ciência da operação, pelo certificado A1 do cliente.
-- =============================================================================

-- O cofre passa a guardar a credencial (chave e cadeia em PEM), e não o PFX
-- protegido por uma senha que o sistema descartou. Linha antiga continua
-- legível para metadados, mas não serve para coleta: pede reenvio.
alter table public.certificates
  add column if not exists credential_format text not null default 'pfx_protected'
    check (credential_format in ('pfx_protected', 'pem_bundle'));

comment on column public.certificates.credential_format is
  'pem_bundle: chave e cadeia cifradas, utilizáveis pela coleta. pfx_protected: PFX com senha descartada, não utilizável — reenviar.';

-- Quem pediu a coleta. É em nome dessa pessoa que cada uso do A1 vira
-- `certificate.used` no log.
alter table public.jobs
  add column if not exists requested_by uuid,
  add column if not exists started_at timestamptz,
  add column if not exists result jsonb;

-- O worker toma o próximo job com `for update skip locked`.
create index if not exists jobs_fila_idx
  on public.jobs (kind, created_at)
  where status = 'queued';

-- Estado da distribuição por CNPJ. A SEFAZ pune consumo indevido (cStat 656)
-- com uma hora sem resposta, e pedir de novo depois de alcançar o `maxNSU`
-- conta como indevido.
create table if not exists public.dfe_sync_state (
  tenant_id      uuid not null,
  cnpj           char(14) not null,
  ult_nsu        char(15) not null default '000000000000000' check (ult_nsu ~ '^[0-9]{15}$'),
  max_nsu        char(15) check (max_nsu is null or max_nsu ~ '^[0-9]{15}$'),
  last_cstat     text,
  last_motivo    text,
  last_run_at    timestamptz,
  -- Até quando não se pede nada: 656, ou fila alcançada.
  blocked_until  timestamptz,
  primary key (tenant_id, cnpj),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

-- Resumos (resNFe) de notas em que o CNPJ é destinatário. A NF-e completa só
-- vem depois da ciência da operação; esta tabela é o que falta chegar.
create table if not exists public.dfe_summaries (
  tenant_id        uuid not null,
  cnpj             char(14) not null,
  access_key       char(44) not null,
  nsu              char(15) not null,
  issuer_cnpj      char(14),
  issuer_name      text,
  issued_at        timestamptz,
  total_cents      bigint,
  -- Ciência da operação (210210): quando foi registrada, e o cStat da SEFAZ.
  manifested_at    timestamptz,
  manifest_cstat   text,
  manifest_motivo  text,
  -- Quando o XML completo entrou pela distribuição.
  received_at      timestamptz,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, cnpj, access_key),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

-- NF-e completas que a distribuição trouxe. A nota só entra no log se a
-- competência dela estiver aberta (camada 4). A SEFAZ devolve notas dos últimos
-- 90 dias, e ingerir na hora gravaria `output.rejected` permanente para cada
-- nota de mês ainda não aberto. A nota espera aqui, e entra na coleta seguinte
-- à abertura da competência.
create table if not exists public.dfe_documents (
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  access_key    char(44) not null,
  nsu           char(15) not null,
  period        char(7) check (period is null or period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  xml           text not null,
  received_at   timestamptz not null default now(),
  -- Entrou no log (ou já estava lá, por upload manual).
  ingested_at   timestamptz,
  -- Recusada pelo pipeline: o motivo, e a nota não é tentada de novo.
  ingest_error  text,
  primary key (tenant_id, cnpj, access_key),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists dfe_documents_pendentes_idx
  on public.dfe_documents (tenant_id, cnpj, period)
  where ingested_at is null and ingest_error is null;

create index if not exists dfe_summaries_pendentes_idx
  on public.dfe_summaries (tenant_id, cnpj)
  where manifested_at is null;

alter table public.dfe_sync_state enable row level security;
alter table public.dfe_summaries  enable row level security;
alter table public.dfe_documents  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['dfe_sync_state', 'dfe_summaries', 'dfe_documents']
  loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (public.is_member_of(tenant_id))',
      t, t
    );
  end loop;
end $$;

-- Chave de acesso com CNPJ alfanumérico (NT Conjunta CNPJ Alfanumérico
-- 2025.001): letras só nas 12 posições do CNPJ do emitente. A restrição tem
-- nome fixo, e é trocada aqui em vez de declarada inline, para valer também no
-- banco onde esta migration já tinha rodado com a regra só de dígitos.
do $$
declare t text;
begin
  foreach t in array array['dfe_summaries', 'dfe_documents']
  loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_access_key_check');
    execute format(
      'alter table public.%I add constraint %I check (access_key ~ ''^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'')',
      t, t || '_access_key_check'
    );
  end loop;
end $$;
