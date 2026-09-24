-- =============================================================================
-- audit — passo 16 de 26: dia_util_nos_prazos
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260923100000_dia_util_nos_prazos.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- Prazo em dia útil, e prazo antecipado para o dia útil anterior.
--
-- `deadline_rules` só sabia expressar dia de calendário, e os dois prazos que
-- mais importam não são dia de calendário:
--
--   - EFD-Contribuições vence no **décimo dia útil** do segundo mês subsequente
--     (IN RFB 1.252/2012, art. 7º).
--   - O DAS do Simples vence **dia 20, antecipado** para o dia útil anterior
--     quando cai em fim de semana ou feriado (LC 123/2006, art. 21).
--
-- Datá-los como dia de calendário colocaria data errada ao lado de uma citação
-- legal — e no caso do DAS erraria para FRENTE, dizendo ao contador que ainda há
-- prazo quando o pagamento já venceu. É a única direção de erro que este
-- calendário não pode ter.
--
-- `exact` é o padrão e preserva o comportamento de toda regra já cadastrada.
alter table public.deadline_rules
  add column if not exists day_rule text not null default 'exact'
    check (day_rule in ('exact', 'nth_business_day', 'anticipate_to_business_day'));

comment on column public.deadline_rules.day_rule is
  'Como day_of_month vira data: exact (o dia é o dia), nth_business_day (N-ésimo dia útil do mês) ou anticipate_to_business_day (o dia, antecipado para o dia útil anterior). O cálculo de dia útil considera os feriados nacionais mais Carnaval e Corpus Christi; feriado estadual e municipal não são conhecidos, e nesses casos a data sai um dia depois da real — o alerta dispara cedo, nunca tarde.';
