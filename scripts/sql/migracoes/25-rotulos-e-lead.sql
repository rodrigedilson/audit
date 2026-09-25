-- =============================================================================
-- audit — passo 25 de 35: rotulos-e-lead
--
-- Rótulo em PT-BR de cada feature do plano, para a tela de preço não
-- inventar nomes, e a função que anexa o lead a um diagnóstico já feito,
-- para a tela não reenviar os XMLs só para registrar o e-mail.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260925100000_rotulos_de_feature.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Rótulos das features do plano
--
-- `plans.features` guarda chaves (`saude_cadastro`, `apuracao_dual`…), e o
-- frontend precisava traduzir cada uma para português. Sem esta tabela, quem
-- constrói a tela inventa os nomes — e foi o que aconteceu: a página de preço
-- saiu com rótulos escritos por quem não conhece o produto.
--
-- O nome comercial de uma funcionalidade é decisão de produto, muda mais que o
-- preço, e não pode exigir deploy. Mesma razão que já pôs `plans` em tabela.
-- =============================================================================

create table if not exists public.plan_features (
  key         text primary key,
  label       text not null,
  -- Uma linha explicando o que o escritório ganha. A tela pode usar como
  -- tooltip ou subtítulo; sem isso o rótulo sozinho não vende nada.
  description text,
  -- Ordem de exibição. A lista em `plans.features` está na ordem em que as
  -- ondas entregaram, que não é a ordem em que o cliente quer ler.
  sort_order  smallint not null default 100,
  updated_at  timestamptz not null default now()
);

comment on table public.plan_features is
  'Rótulo em PT-BR de cada chave de `plans.features`. Evita o frontend inventar nomes.';

insert into public.plan_features (key, label, description, sort_order) values
  ('saude_cadastro',     'Saúde do cadastro de itens',
   'Aponta item sem NCM, código incompatível e classificação que contamina a apuração.', 10),
  ('coleta_dfe',         'Coleta automática de documentos',
   'Busca as notas na SEFAZ com o certificado A1, sem alguém baixar XML à mão.', 20),
  ('simulador_opcao',    'Simulador de opção de regime',
   'Compara Simples integrado, híbrido e Presumido para decidir dentro do prazo.', 30),
  ('apuracao_dual',      'Apuração dual, nota a nota',
   'Tributos atuais e IBS/CBS lado a lado no mesmo item, com memória de cálculo.', 40),
  ('contra_apuracao',    'Contra-apuração contra o Fisco',
   'Compara a sua apuração com a proposta do Fisco e lista as divergências.', 50),
  ('calendario',         'Calendário de prazos',
   'Prazos de manifestação e fechamento por CNPJ, em dia útil.', 60),
  ('assistente_fiscal',  'Assistente fiscal',
   'Responde sobre a carteira citando o evento que sustenta cada resposta. Nunca escreve.', 70),
  ('credito_em_risco',   'Crédito em risco por fornecedor',
   'Crédito que depende do pagamento da etapa anterior, cruzado com o extrato.', 80),
  ('dossie_saldo_credor','Dossiê de saldo credor de PIS/Cofins',
   'Reúne a evidência do saldo acumulado antes de PIS e Cofins serem extintos.', 90),
  ('sped_completo',      'SPED completo',
   'EFD ICMS/IPI e EFD-Contribuições conciliadas com os documentos recebidos.', 100),
  ('white_label',        'White label',
   'O escritório entrega os relatórios com a marca dele.', 110)
on conflict (key) do update
   set label       = excluded.label,
       description = excluded.description,
       sort_order  = excluded.sort_order,
       updated_at  = now();

-- Pública, como `plans` e `pricing_tiers`: a página de preço não tem sessão.
alter table public.plan_features disable row level security;

-- =============================================================================
-- Lead do diagnóstico sem reprocessar o lote
--
-- O diagnóstico já aceitava e-mail junto do upload, mas a tela mostra o
-- relatório primeiro e só depois oferece o envio por e-mail — que é a ordem
-- correta, porque muro de e-mail é a opacidade que o produto combate. Sem uma
-- rota própria, a tela reenviava os mesmos XMLs só para registrar o endereço:
-- parsing duplicado, e uma segunda linha de métrica para o mesmo diagnóstico.
--
-- A resposta do diagnóstico passa a devolver o `id` da linha, e o lead é
-- gravado nela. O `id` é um UUID v4: não é enumerável, e a única coisa que se
-- pode fazer com um palpite certo é anexar um e-mail a um contador anônimo.
-- =============================================================================

-- Um lead por diagnóstico. Sem isto, reenviar o formulário sobrescreveria o
-- endereço já consentido — e a data de consentimento junto.
create or replace function public.registrar_lead_do_diagnostico(
  p_report_id uuid,
  p_email     text,
  p_source    text
) returns boolean
  language plpgsql as $$
declare
  atualizadas integer;
begin
  update public.readiness_reports
     set email            = p_email,
         email_consent_at = now(),
         source           = coalesce(p_source, source)
   where id = p_report_id
     and email is null;

  get diagnostics atualizadas = row_count;
  return atualizadas > 0;
end $$;

comment on function public.registrar_lead_do_diagnostico is
  'Anexa e-mail consentido a um diagnóstico já feito. Falso quando o id não existe ou já tem lead.';
