-- =============================================================================
-- audit — passo 10 de 42: credito-por-fornecedor
--
-- Extrato bancário, casamento pagamento × documento e o crédito em risco por
-- fornecedor. Não há tabela de posição de crédito de propósito: o estado é
-- DERIVADO na leitura, porque gravá-lo congelaria o crédito condicionado que
-- envelhece sem pagamento — justamente o achado que a onda existe para mostrar.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921170000_supplier_credit.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 10 — crédito em risco por fornecedor (diferencial #7)
--
-- "Players fiscais não olham o banco." É esse o vão que esta onda ocupa: o
-- crédito de IBS/CBS é **condicionado à extinção do tributo da etapa anterior**,
-- e sob split payment a extinção acontece na liquidação financeira. Logo, o
-- extrato bancário é informação fiscal.
--
-- O limite do que este sistema pode afirmar, escrito no schema para não se
-- perder:
--
-- - Ele NÃO SABE se o fornecedor recolheu o tributo dele. Essa informação é do
--   Fisco, e não existe fonte para ela hoje. Por isso `released` exige evidência
--   explícita e não é derivado de palpite nenhum — e vai ficar raro até haver
--   fonte, o que é a verdade e precisa aparecer na tela.
-- - Ele SABE (ou pode inferir do extrato) se **nós** pagamos o fornecedor. E
--   isso basta para um achado defensável: sem liquidação não há split payment,
--   e sem split payment o crédito não se extingue. Nosso não-pagamento é o sinal
--   de risco que o produto consegue observar de fato.
-- - O casamento entre linha de extrato e documento é HIPÓTESE. Valor e data
--   iguais não provam que aquele pagamento é daquela nota, e casar errado
--   reportaria crédito liberado que não está. Por isso o casamento tem grau de
--   confiança e o ambíguo não é resolvido no palpite.
-- =============================================================================

do $$
begin
  create type public.statement_source as enum ('ofx', 'csv');
exception when duplicate_object then
  null;
end $$;

do $$
begin
  create type public.match_confidence as enum (
    /** A chave de acesso ou o número da nota aparece no histórico do lançamento. */
    'exact',
    /** Valor idêntico e data dentro da janela. Hipótese forte, não prova. */
    'amount_and_date',
    /** Valor idêntico e data fora da janela. Hipótese fraca. */
    'amount_only',
    /** Mais de um documento candidato. NÃO resolvido: ver comentário. */
    'ambiguous'
  );
exception when duplicate_object then
  null;
end $$;

-- ------------------------------------------------------------ extrato
create table if not exists public.bank_statements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  cnpj         char(14) not null,

  source       public.statement_source not null,
  -- Nome do arquivo ou identificação da conta: o que permite dizer depois o que
  -- foi importado e quando.
  reference    text not null,
  account      text,

  period_from  date,
  period_to    date,
  lines_count  integer not null default 0,

  event_seq    bigint not null,
  imported_by  uuid,
  imported_at  timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists bank_statements_scope_idx
  on public.bank_statements (tenant_id, cnpj, imported_at desc);

alter table public.bank_statements enable row level security;
drop policy if exists bank_statements_select_own on public.bank_statements;
create policy bank_statements_select_own on public.bank_statements
  for select using (public.is_member_of(tenant_id));

create table if not exists public.bank_statement_lines (
  id            bigserial primary key,
  tenant_id     uuid not null,
  cnpj          char(14) not null,
  statement_id  uuid not null references public.bank_statements (id) on delete cascade,

  /**
   * Identificador do lançamento no arquivo (FITID, no OFX).
   *
   * É o que torna a reimportação idempotente: o mesmo extrato enviado duas vezes
   * não pode dobrar o pagamento, senão o crédito apareceria liberado por um
   * pagamento que aconteceu uma vez só.
   */
  fitid         text,
  posted_at     date not null,
  -- Negativo é saída de caixa. Pagamento a fornecedor é negativo.
  amount_cents  bigint not null,
  description   text not null default '',
  counterparty_doc char(14),

  unique (tenant_id, cnpj, fitid)
);

create index if not exists bank_lines_busca_idx
  on public.bank_statement_lines (tenant_id, cnpj, posted_at, amount_cents);

alter table public.bank_statement_lines enable row level security;
drop policy if exists bank_lines_select_own on public.bank_statement_lines;
create policy bank_lines_select_own on public.bank_statement_lines
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------- casamento pagamento × documento
--
-- Separado das linhas de extrato de propósito: o casamento é uma conclusão sobre
-- os dados, e não um dado. Reprocessá-lo não pode alterar o extrato importado.
create table if not exists public.payment_matches (
  tenant_id    uuid not null,
  cnpj         char(14) not null,
  access_key   char(44) not null,
  line_id      bigint not null references public.bank_statement_lines (id) on delete cascade,

  confidence   public.match_confidence not null,
  -- Por que o casamento foi feito, em texto: é o que o contador confere.
  rationale    text not null,
  matched_at   timestamptz not null default now(),

  primary key (tenant_id, cnpj, access_key, line_id)
);

alter table public.payment_matches enable row level security;
drop policy if exists payment_matches_select_own on public.payment_matches;
create policy payment_matches_select_own on public.payment_matches
  for select using (public.is_member_of(tenant_id));

-- ------------------------------------------------------ posição do crédito
--
-- **Não existe tabela de posição de crédito, e isso é decisão.**
--
-- O estado do crédito é DERIVADO na leitura, a partir dos documentos, dos itens
-- e dos casamentos gravados acima. Gravá-lo congelaria o estado na data do
-- cálculo, e a deterioração de um crédito antigo — o crédito condicionado que
-- envelhece sem pagamento — é justamente o achado que esta onda existe para
-- mostrar. Um `state` em tabela teria de ser reprocessado por algum job, e entre
-- dois reprocessamentos o número na tela estaria velho sem avisar.
--
-- O que É gravado são os fatos: o extrato importado e o casamento
-- pagamento × documento, que é conclusão revisável pelo contador. A
-- classificação e a agregação por fornecedor vivem em `credit-risk.ts`, em uma
-- única implementação, com teste unitário.
