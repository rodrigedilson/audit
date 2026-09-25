-- =============================================================================
-- audit — passo 2 de 32: cofre-certificados
--
-- Cofre dos certificados A1. O PFX entra cifrado pela aplicação; o banco
-- nunca vê a chave nem a senha.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260918130000_certificate_vault.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 2 — cofre de certificados A1 (diferencial #4 do roadmap)
--
-- O PFX permite agir em nome do contribuinte perante o Fisco. Fica cifrado com
-- AES-256-GCM pela aplicação (chave mestra fora do banco) e nunca é devolvido
-- pela API: só metadados. Todo uso vira evento `certificate.used` no event log,
-- o que dá trilha de acesso sem precisar de mecanismo separado.
-- =============================================================================

create table if not exists public.certificates (
  tenant_id     uuid not null,
  cnpj          char(14) not null check (cnpj ~ '^[0-9]{14}$'),

  -- `iv:authTag:ciphertext` em base64. Cifragem é da aplicação, não do banco:
  -- pgcrypto deixaria a chave no servidor de banco, junto do dado que ela
  -- protege.
  encrypted_pfx text not null,
  -- SHA-256 do PFX em claro. Detecta troca silenciosa do arquivo por quem tenha
  -- acesso de escrita à tabela.
  fingerprint   char(64) not null,

  subject       text not null,
  issuer        text not null,
  serial        text not null,
  valid_from    timestamptz not null,
  valid_to      timestamptz not null,
  stored_at     timestamptz not null default now(),
  stored_by     uuid not null,

  primary key (tenant_id, cnpj),
  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade,
  constraint certificates_validity_order check (valid_to > valid_from)
);

-- Alimenta `GET /certificates/expiring`, que é o alerta que evita a coleta de
-- DF-e parar sem ninguém perceber.
create index if not exists certificates_expiry_idx on public.certificates (tenant_id, valid_to);

alter table public.certificates enable row level security;

-- Somente leitura de metadados, e nem isso inclui o PFX: a coluna
-- `encrypted_pfx` nunca é selecionada pela API. Sem policy de escrita, todo
-- write do cliente é negado; a API escreve com a service role.
drop policy if exists certificates_select_own on public.certificates;
create policy certificates_select_own on public.certificates
  for select using (public.is_member_of(tenant_id));
