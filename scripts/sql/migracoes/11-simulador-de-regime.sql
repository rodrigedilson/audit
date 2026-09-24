-- =============================================================================
-- audit — passo 11 de 19: simulador-de-regime
--
-- Registro das simulações de regime. Não é apuração e não gera evento
-- fiscal: guarda as premissas com que o escritório aconselhou, porque elas
-- vão mudar quando as alíquotas de referência forem publicadas.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921180000_simulation.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 11 — simulador Integrado × Híbrido × Presumido (diferencial #8)
--
-- O simulador é **somente leitura** sobre os dados da carteira e **não grava
-- evento fiscal nenhum**: escolher regime é decisão do contador, e o art. 40-D
-- dá uma janela para ela. O que esta migration cria é o registro do que foi
-- simulado, e não um número fiscal.
--
-- Por que guardar a simulação, se ela não é apuração: a recomendação vai
-- orientar a escolha de regime do cliente para toda a transição, e o escritório
-- precisa poder mostrar depois com que premissas aconselhou. Uma recomendação
-- sem registro das premissas é indefensável seis meses depois — e as alíquotas
-- de referência ainda não estão publicadas, então as premissas vão mudar.
-- =============================================================================

create table if not exists public.simulations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  cnpj          char(14) not null,

  scenario      text not null check (scenario in ('transition_2027_2028', 'full_2033')),
  base_from     char(7) not null,
  base_to       char(7) not null,

  /** Entradas exatas, incluindo as premissas informadas. */
  inputs        jsonb not null,
  /** Saída completa: resultados, sensibilidade, premissas e o que não é modelado. */
  result        jsonb not null,

  /**
   * Regime vencedor, ou `null` quando ele muda dentro da faixa de premissas
   * explorada. `null` aqui é resposta, não ausência de resposta: significa que a
   * escolha depende de uma alíquota que ainda não foi publicada.
   */
  winner        public.regime,
  robustness    text not null check (robustness in ('robust', 'sensitive')),

  simulated_by  uuid,
  simulated_at  timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists simulations_scope_idx
  on public.simulations (tenant_id, cnpj, simulated_at desc);

alter table public.simulations enable row level security;
drop policy if exists simulations_select_own on public.simulations;
create policy simulations_select_own on public.simulations
  for select using (public.is_member_of(tenant_id));

comment on table public.simulations is
  'Registro de simulações de regime. Não é apuração e não gera evento fiscal: '
  'guarda as premissas com que o escritório aconselhou, porque elas vão mudar '
  'quando as alíquotas de referência forem publicadas.';
