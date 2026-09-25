-- =============================================================================
-- audit — passo 24 de 32: teto-da-assinatura
--
-- Teto global da assinatura em R$ 25.000/mês. O critério é não morder dentro
-- do ICP (até 300 CNPJs) em nenhum regime — o pior caso é Lucro Real, que a
-- 300 CNPJs paga R$ 24.030. Carteira acima disso é caso de override por
-- contrato, em subscriptions.cap_cents_override.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260924200000_teto_da_assinatura.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Teto global da assinatura
--
-- A migration das faixas criou a coluna e deixou `cap_cents` nulo, porque teto é
-- decisão comercial e não default. Este passo escolhe o número, com o critério
-- escrito para quem for mudá-lo depois.
--
-- CRITÉRIO: o teto não pode morder dentro do ICP declarado (20 a 300 CNPJs), em
-- nenhum regime. Se mordesse, a degressão estaria dando desconto justamente aos
-- clientes que o produto foi desenhado para atender, e no regime que mais paga.
--
-- Fatura mensal de uma carteira homogênea de 300 CNPJs, com a escada vigente:
--
--     MEI/SN integrado   R$  2.430
--     Simples híbrido    R$  7.830
--     Lucro presumido    R$ 13.230
--     Lucro real         R$ 24.030   <- o pior caso manda no número
--
-- Daí R$ 25.000: é o primeiro valor redondo acima de R$ 24.030. Onde cada teto
-- candidato começaria a morder, em nº de CNPJs:
--
--     teto          MEI    SN híbrido   LP     LR
--     R$  9.000    1561        358     199    102   <- morde dentro do ICP
--     R$ 12.000    2227        506     271    141   <- morde dentro do ICP
--     R$ 18.000    3561        835     440    221   <- morde dentro do ICP
--     R$ 25.000   nunca       1285     651    316   <- respeita o ICP inteiro
--
-- O QUE ESTE TETO **NÃO** RESOLVE, e é preciso dizer: uma carteira de 1.200
-- CNPJs de Simples Híbrido custa R$ 23.780/mês e continua abaixo do teto, ou
-- seja, o teto não a toca. Baixar o teto até alcançá-la machucaria o ICP (ver
-- tabela acima). Carteira desse porte é caso de `subscriptions.cap_cents_override`,
-- negociado em contrato — que é exatamente por isso que o override existe.
-- =============================================================================

update public.billing_settings
   set cap_cents = 2500000,
       updated_at = now()
 where id = true
   -- Só define o padrão; não sobrescreve um teto já escolhido conscientemente.
   and cap_cents is null;
