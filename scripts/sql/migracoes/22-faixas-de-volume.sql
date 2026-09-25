-- =============================================================================
-- audit — passo 22 de 37: faixas-de-volume
--
-- Degressão por volume: faixas marginais de desconto por quantidade de CNPJs
-- faturáveis, e a coluna do teto de assinatura. O desconto marginal é
-- limitado a 50% por monotonicidade; acima disso quem carrega é o teto.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924180000_faixas_de_volume.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Degressão por volume — faixas marginais e teto de assinatura
--
-- O preço linear por CNPJ quebra no topo do público-alvo: uma carteira de 1.200
-- CNPJs de Simples Híbrido custaria R$ 34.800/mês, que nenhum escritório paga.
--
-- A escada é MARGINAL, como alíquota de imposto de renda: cada faixa desconta
-- só as unidades que caem dentro dela. Desconto de faixa aplicado ao total
-- inteiro criaria penhasco — 100 CNPJs custariam R$ 2.900,00 e 101 custariam
-- R$ 2.492,15, e acrescentar um cliente BAIXARIA a fatura. Num produto que se
-- vende contra opacidade de preço, uma tabela onde crescer sai mais barato é
-- indefensável na tela e vira arbitragem.
--
-- Os parâmetros ficam em tabela e não no código pela mesma razão de `plans`:
-- mudar preço não pode exigir deploy.
-- =============================================================================

create table if not exists public.pricing_tiers (
  -- Chave natural: o início da faixa. Impede por construção duas faixas
  -- começando no mesmo ponto, que um `id serial` deixaria passar.
  from_clients   integer primary key check (from_clients >= 1),

  -- Desconto MARGINAL em pontos-base (1500 = 15%).
  --
  -- O teto de 5000 (50%) NÃO é gosto comercial: é a condição de monotonicidade
  -- do modelo. Acrescentar um CNPJ caro o insere nas primeiras posições e empurra
  -- um "atravessador" por fronteira de faixa; o saldo de acrescentá-lo é
  -- `>= preço × (1 - 2·desconto_máximo)`, positivo se e somente se o desconto
  -- máximo for menor que 50%. Acima disso, acrescentar um CNPJ passaria a baixar
  -- a fatura. Degressão maior é caso de teto (`billing_settings.cap_cents`), que
  -- não depende da posição de ninguém e por isso não quebra a monotonicidade.
  discount_bps   integer not null check (discount_bps between 0 and 5000),

  label          text,
  effective_from date not null default current_date,
  updated_at     timestamptz not null default now()
);

comment on table public.pricing_tiers is
  'Faixas marginais de desconto por volume de CNPJs faturáveis. Teto de 50% por monotonicidade.';

-- Só semeia tabela vazia. `on conflict (from_clients)` deixou de servir quando a
-- chave passou a ser `(effective_from, from_clients)` (migration
-- `20260925120000_versao_das_faixas`), e reaplicar esta semente com a data de
-- hoje criaria uma escada nova por dia.
insert into public.pricing_tiers (from_clients, discount_bps, label)
select f.from_clients, f.discount_bps, f.label
  from (values
    (1,    0,    'Até 100 CNPJs'),
    (101,  1500, '101 a 300 CNPJs'),
    (301,  3000, '301 a 600 CNPJs'),
    (601,  4000, '601 a 1.000 CNPJs'),
    (1001, 5000, 'Acima de 1.000 CNPJs')
  ) as f (from_clients, discount_bps, label)
 where not exists (select 1 from public.pricing_tiers);

-- Pública de propósito, como `plans` e `billing_settings`: a escada vai na
-- página de preço, antes de qualquer contato comercial.
alter table public.pricing_tiers disable row level security;

-- Teto global da assinatura. Nulo por padrão: o teto é decisão consciente de
-- contrato, não um default que ninguém escolheu.
alter table public.billing_settings
  add column if not exists cap_cents integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'billing_settings_cap_acima_do_minimo'
  ) then
    alter table public.billing_settings
      add constraint billing_settings_cap_acima_do_minimo
      check (cap_cents is null or cap_cents >= minimum_cents);
  end if;
end $$;

-- Teto por escritório, para o contrato que foge da tabela. Fica em
-- `subscriptions` e não em `tenants` porque teto é cláusula de assinatura, e
-- morre junto com o cancelamento.
alter table public.subscriptions
  add column if not exists cap_cents_override integer check (cap_cents_override >= 0);
