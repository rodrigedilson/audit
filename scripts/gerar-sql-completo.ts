#!/usr/bin/env tsx
/**
 * Gera o SQL pronto para colar no SQL Editor do Supabase, em dois formatos:
 *
 *   scripts/sql/setup-completo.sql      tudo de uma vez
 *   scripts/sql/migracoes/NN-nome.sql   um passo por arquivo
 *
 * Os dois saem das mesmas migrations. O formato numerado existe porque um erro
 * no meio de 700 linhas coladas de uma vez é difícil de localizar no editor;
 * passo a passo, a mensagem do Postgres aponta o arquivo.
 *
 * É gerado, e não escrito à mão, porque uma cópia manual das migrations
 * divergiria na primeira alteração — e a divergência só apareceria quando o
 * banco de produção deixasse de bater com o que os testes exercitam.
 *
 *   npm run sql:bundle
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');
const SAIDA_BUNDLE = join(process.cwd(), 'scripts/sql/setup-completo.sql');
const SAIDA_PASSOS = join(process.cwd(), 'scripts/sql/migracoes');

/** Nome legível de cada migration, para o arquivo numerado. */
const TITULOS: Record<string, string> = {
  '20260927140000_anon_nos_catalogos.sql': 'anon-nos-catalogos',
  '20260927200000_capag.sql': 'capag',
  '20260927210000_capag_no_plano.sql': 'capag-no-plano',
  '20260927120000_indices_financeiros.sql': 'indices-financeiros',
  '20260918120000_multi_tenancy.sql': 'multi-tenancy',
  '20260918130000_certificate_vault.sql': 'cofre-certificados',
  '20260918140000_billing.sql': 'cobranca',
  '20260918150000_ingestion.sql': 'ingestao',
  '20260921120000_catalog.sql': 'catalogo-de-itens',
  '20260921130000_assessment.sql': 'apuracao-dual',
  // Mantido em inglês porque é o nome com que este passo já foi aplicado; trocar
  // agora faria o arquivo divergir do que está rodando nos ambientes.
  '20260921140000_reporting.sql': 'reporting',
  '20260921150000_reconciliation.sql': 'contra-apuracao',
  '20260921160000_assistant.sql': 'assistente-fiscal',
  '20260921170000_supplier_credit.sql': 'credito-por-fornecedor',
  '20260921180000_simulation.sql': 'simulador-de-regime',
  '20260921190000_credit_dossier.sql': 'dossie-saldo-credor',
  '20260922100000_propagacao_de_item_nao_classificado.sql': 'correcao-propagacao',
  '20260924100000_ativacao_da_cobranca.sql': 'ativacao-da-cobranca',
  '20260924130000_coleta_dfe.sql': 'coleta-dfe',
  '20260924150000_chave_alfanumerica.sql': 'chave-alfanumerica',
  '20260924180000_faixas_de_volume.sql': 'faixas-de-volume',
  '20260924190000_diagnostico_publico.sql': 'diagnostico-publico',
  '20260924200000_teto_da_assinatura.sql': 'teto-da-assinatura',
  '20260925100000_rotulos_de_feature.sql': 'rotulos-e-lead',
  '20260925120000_versao_das_faixas.sql': 'versao-das-faixas',
  '20260925130000_remove_projection_snapshots.sql': 'remove-projection-snapshots',
  '20260925140000_auditoria_continua.sql': 'auditoria-continua',
  '20260926100000_cancelamento_de_nfe.sql': 'cancelamento-de-nfe',
  '20260926120000_efd_icms_demais_registros.sql': 'efd-icms-demais-registros',
  '20260926140000_coleta_agendada.sql': 'coleta-agendada',
  '20260926160000_relatorio_do_diagnostico.sql': 'relatorio-do-diagnostico',
};

const DESCRICOES: Record<string, string> = {
  '20260927210000_capag_no_plano.sql':
    'CAPAG presumida nos planos Simples híbrido, Lucro Presumido e Lucro Real,\n' +
    '-- os que já incluem o assistente fiscal.',
  '20260927200000_capag.sql':
    'CAPAG presumida: a fórmula de referência (doutrina, nunca conferida) e os\n' +
    '-- demonstrativos do REGULARIZE por CNPJ, extraídos trecho a trecho.',
  '20260927140000_anon_nos_catalogos.sql':
    'Fecha a chave anon os quatro catalogos globais. Dado sem tenant_id nao e\n' +
    '-- o mesmo que dado que precisa ser publico: nenhuma tela publica os\n' +
    '-- consome, e quem os le e a nossa API, autenticada.',
  '20260927120000_indices_financeiros.sql':
    'Series de indice financeiro versionadas por competencia, para a correcao\n' +
    '-- monetaria dizer qual indice, qual periodo e qual fonte. Nascem vazias e\n' +
    '-- nao conferidas: indice errado num laudo e pior que laudo sem indice.',
  '20260926120000_efd_icms_demais_registros.sql':
    'EFD ICMS/IPI: a conciliação passa a somar energia, transporte, comunicação\n' +
    '-- e varejo (C590, D190, D590, C320 a C890) contra o E110, e cada linha diz\n' +
    '-- qual analítico soma. Atualiza a descrição da feature sped_completo.',
  '20260926160000_relatorio_do_diagnostico.sql':
    'Relatório do diagnóstico público por e-mail: o resumo fica cifrado por até\n' +
    '-- 24h, só para o envio, e o link de remoção do e-mail (LGPD).',
  '20260926140000_coleta_agendada.sql':
    'Coleta de DF-e agendada por opt-in do owner (ADR-007): quem ligou e quando\n' +
    '-- ficam no cadastro, e o job do agendador é marcado como tal.',
  '20260926100000_cancelamento_de_nfe.sql':
    'Cancelamento de NF-e pela distribuição: a nota cancelada fica marcada e\n' +
    '-- sai das somas, e todo evento trazido pela SEFAZ é guardado, inclusive o\n' +
    '-- que não pode ser aplicado por a competência já estar confirmada.',
  '20260925140000_auditoria_continua.sql':
    'Teste de comprovacao e inspecao documentaria: criterios de avaliacao,\n' +
    '-- execucoes por censo, achados com risco por probabilidade x impacto e\n' +
    '-- estorno que exige humano identificado. Os criterios nascem NAO\n' +
    '-- conferidos: o achado existe, aparece e nao afirma.',
  '20260925130000_remove_projection_snapshots.sql':
    'Remove a tabela de snapshot da projeção, órfã desde a primeira migration:\n' +
    '-- nada nunca escreveu nela, e um cache vazio afirma um cache que não existe.',
  '20260925120000_versao_das_faixas.sql':
    'Escada de faixas versionada por data: vale a de maior effective_from até\n' +
    '-- hoje, inteira. Agendar uma escada é inserir as faixas com data futura.',
  '20260925100000_rotulos_de_feature.sql':
    'Rótulo em PT-BR de cada feature do plano, para a tela de preço não\n' +
    '-- inventar nomes, e a função que anexa o lead a um diagnóstico já feito,\n' +
    '-- para a tela não reenviar os XMLs só para registrar o e-mail.',
  '20260924150000_chave_alfanumerica.sql':
    'Chave de acesso com CNPJ alfanumérico: letras nas 12 posições do CNPJ do\n' +
    '-- emitente. Troca toda restrição que ainda exija a chave só de dígitos.',
  '20260924180000_faixas_de_volume.sql':
    'Degressão por volume: faixas marginais de desconto por quantidade de CNPJs\n' +
    '-- faturáveis, e a coluna do teto de assinatura. O desconto marginal é\n' +
    '-- limitado a 50% por monotonicidade; acima disso quem carrega é o teto.',
  '20260924190000_diagnostico_publico.sql':
    'Métrica agregada do diagnóstico público de prontidão. Uma linha por\n' +
    '-- diagnóstico, sem CNPJ, chave de acesso ou razão social: o relatório é\n' +
    '-- calculado em memória e nada do documento do visitante é guardado.',
  '20260924200000_teto_da_assinatura.sql':
    'Teto global da assinatura em R$ 25.000/mês. O critério é não morder dentro\n' +
    '-- do ICP (até 300 CNPJs) em nenhum regime — o pior caso é Lucro Real, que a\n' +
    '-- 300 CNPJs paga R$ 24.030. Carteira acima disso é caso de override por\n' +
    '-- contrato, em subscriptions.cap_cents_override.',
  '20260924130000_coleta_dfe.sql':
    'Coleta de DF-e na SEFAZ (ADR-006): formato da credencial no cofre, fila de\n' +
    '-- jobs, estado do NSU por CNPJ, resumos para ciência e NF-e baixadas que\n' +
    '-- esperam a competência abrir.',
  '20260924100000_ativacao_da_cobranca.sql':
    'Dados de cobrança do escritório (CPF/CNPJ, e-mail, forma de pagamento),\n' +
    '-- preenchidos quando o owner ativa a cobrança. Sem ativação não há\n' +
    '-- assinatura no Asaas: o trial acaba sem virar cobrança por omissão.',
  '20260918120000_multi_tenancy.sql':
    'Escritórios, usuários, CNPJs, competências e o event log.\n' +
    '-- Cria append_event(), que serializa a escrita por CNPJ, e o trigger que\n' +
    '-- torna a tabela de eventos append-only.',
  '20260918130000_certificate_vault.sql':
    'Cofre dos certificados A1. O PFX entra cifrado pela aplicação; o banco\n' +
    '-- nunca vê a chave nem a senha.',
  '20260918140000_billing.sql':
    'Planos, assinatura e faturas. Popula os 5 planos por regime e o mínimo\n' +
    '-- de R$ 150. Cria billable_clients(), que define "CNPJ ativo".',
  '20260918150000_ingestion.sql':
    'Documentos fiscais e seus itens, com tributos atuais e IBS/CBS lado a lado.',
  '20260921120000_catalog.sql':
    'Catálogo de itens com classificação versionada por vigência, tabelas de\n' +
    '-- códigos oficiais e as funções effective_classification() e\n' +
    '-- item_propagation() — esta última responde quantas notas emitidas cada\n' +
    '-- item mal classificado contaminou.',
  '20260921130000_assessment.sql':
    'Motor de regras com vigência por data, apuração dual e a memória de\n' +
    '-- cálculo linha por linha. A tabela `tax_rules` nasce VAZIA de propósito:\n' +
    '-- sem regra publicada o valor devido vem nulo com o motivo, nunca um\n' +
    '-- número assumido.',
  '20260921140000_reporting.sql':
    'Catálogo das 12 trilhas de auditoria e a tabela do Book de fechamento.\n' +
    '-- As trilhas semeadas são exatamente as checagens que ESTE sistema\n' +
    '-- executa, e não uma lista de verificações da RFB. Os bytes do PDF ficam\n' +
    '-- guardados: o Book carrega um hash no rodapé e regerá-lo depois de uma\n' +
    '-- regra mudar produziria outro arquivo com o mesmo número.',
  '20260922100000_propagacao_de_item_nao_classificado.sql':
    'Correção: a propagação ignorava o item nunca classificado, e o número que\n' +
    '-- sustenta o diferencial #1 lia zero exatamente no estado em que mais\n' +
    '-- importa — o do escritório que ingeriu e ainda não classificou nada.',
  '20260921190000_credit_dossier.sql':
    'EFD-Contribuições importada e a janela de cobertura documental. O dossiê de\n' +
    '-- saldo credor NÃO é gravado: é derivado da escrituração mais a base de\n' +
    '-- documentos de agora, porque congelá-lo esconderia o ganho de lastro de\n' +
    '-- quando o escritório localiza um XML que faltava.',
  '20260921180000_simulation.sql':
    'Registro das simulações de regime. Não é apuração e não gera evento\n' +
    '-- fiscal: guarda as premissas com que o escritório aconselhou, porque elas\n' +
    '-- vão mudar quando as alíquotas de referência forem publicadas.',
  '20260921170000_supplier_credit.sql':
    'Extrato bancário, casamento pagamento × documento e o crédito em risco por\n' +
    '-- fornecedor. Não há tabela de posição de crédito de propósito: o estado é\n' +
    '-- DERIVADO na leitura, porque gravá-lo congelaria o crédito condicionado que\n' +
    '-- envelhece sem pagamento — justamente o achado que a onda existe para mostrar.',
  '20260921160000_assistant.sql':
    'Conversas do assistente fiscal e a cota mensal por CNPJ, tirada do plano\n' +
    '-- do regime. O assistente é somente leitura: não escreve no log fiscal, e\n' +
    '-- toda afirmação factual dele carrega citação de um `event_seq` deste CNPJ.',
  '20260921150000_reconciliation.sql':
    'Proposta do Fisco, divergências nota a nota e o calendário da carteira.\n' +
    '-- `deadline_rules` nasce VAZIA de propósito: as datas da janela do art.\n' +
    '-- 40-D e dos prazos da apuração assistida citadas no briefing não foram\n' +
    '-- conferidas em texto oficial, e alertar na data errada é pior do que não\n' +
    '-- alertar — o escritório passa a confiar.',
};

const CABECALHO = `-- =============================================================================
-- audit — setup completo do Supabase
--
-- ARQUIVO GERADO. Não edite aqui: altere as migrations em supabase/migrations/
-- e rode \`npm run sql:bundle\`. Editar este arquivo faria o banco divergir do
-- que a suíte de testes exercita.
--
-- COMO USAR
--   1. Crie seu usuário antes: Authentication → Users → Add user,
--      marcando "Auto Confirm User". Este projeto está com mailer_autoconfirm
--      desligado, então um cadastro comum fica pendente e o login falha.
--   2. Edite as duas linhas marcadas com CONFIGURE, lá embaixo na PARTE 2.
--   3. Cole o arquivo inteiro no SQL Editor e execute.
--
-- É IDEMPOTENTE: pode rodar de novo sem duplicar nada. Objetos usam
-- \`if not exists\`, e o bootstrap não cria um segundo escritório para quem já
-- tem um.
--
-- O QUE CRIA no schema public:
--   tabelas  tenants, memberships, clients, periods, events,
--            projection_snapshots, jobs, certificates, plans,
--            billing_settings, subscriptions, invoices, billing_events,
--            documents, document_items
--   funções  current_user_id, is_member_of, append_event, billable_clients,
--            events_reject_mutation
--   RLS      ligado em todas as tabelas com tenant_id, apenas policies de
--            SELECT. Sem policy de escrita, todo write vindo do cliente é
--            negado; a API escreve com a service role. O RLS aqui é a segunda
--            tranca: toda escrita fiscal passa pelo pipeline de 7 camadas, e um
--            INSERT direto burlaria isso.
-- =============================================================================

`;

const BOOTSTRAP = `

-- =============================================================================
-- PARTE 2 — bootstrap do escritório
--
-- Vincula um usuário do Supabase Auth a um escritório, como owner. Sem isso a
-- API responde 403 em tudo: o tenant é resolvido pela tabela \`memberships\`, e
-- nunca por um claim do token — um claim fica velho quando alguém sai do
-- escritório, e a sessão antiga continuaria valendo.
-- =============================================================================

do $bootstrap$
declare
  -- ┌──────────────────────────── CONFIGURE ────────────────────────────┐
  v_email       text := 'voce@seudominio.com.br';
  v_escritorio  text := 'Meu Escritório de Contabilidade';
  -- └───────────────────────────────────────────────────────────────────┘

  v_user_id     uuid;
  v_confirmado  boolean;
  v_tenant_id   uuid;
  v_existente   text;
begin
  select id, email_confirmed_at is not null
    into v_user_id, v_confirmado
    from auth.users
   where lower(email) = lower(v_email);

  if v_user_id is null then
    raise exception using
      message = format('Nenhum usuário com e-mail %L em auth.users.', v_email),
      hint = 'Crie em Authentication → Users → Add user, marcando "Auto Confirm User".';
  end if;

  if not v_confirmado then
    raise warning 'E-mail % ainda não confirmado: o login vai falhar até confirmar.', v_email;
  end if;

  select t.name into v_existente
    from memberships m join tenants t on t.id = m.tenant_id
   where m.user_id = v_user_id
   limit 1;

  if v_existente is not null then
    raise notice 'Usuário já pertence a %. Nada a criar.', v_existente;
    return;
  end if;

  insert into tenants (name) values (v_escritorio) returning id into v_tenant_id;
  insert into memberships (tenant_id, user_id, role)
       values (v_tenant_id, v_user_id, 'owner');

  raise notice 'Escritório % criado; % vinculado como owner.', v_escritorio, v_email;
end
$bootstrap$;

-- =============================================================================
-- PARTE 3 — conferência
--
-- Deve devolver uma linha com o seu e-mail e o papel owner.
-- =============================================================================

select
  t.id            as tenant_id,
  t.name          as escritorio,
  t.plan          as plano,
  u.email         as usuario,
  m.role          as papel,
  (select count(*) from plans)   as planos_carregados,
  (select minimum_cents from billing_settings where id) as minimo_centavos
from memberships m
join tenants t on t.id = m.tenant_id
join auth.users u on u.id = m.user_id
order by m.created_at desc
limit 5;
`;

async function main(): Promise<void> {
  // Ordem lexicográfica é a cronológica: os arquivos têm prefixo de timestamp, e
  // aplicar fora de ordem quebraria as chaves estrangeiras.
  const arquivos = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();

  const partes: string[] = [CABECALHO];
  partes.push(
    '-- =============================================================================\n' +
      `-- PARTE 1 — migrations (${arquivos.length} arquivos, na ordem de aplicação)\n` +
      '-- =============================================================================\n',
  );

  for (const arquivo of arquivos) {
    partes.push(
      `\n\n-- ─────────────────────────────────────────────────────────────────────────\n` +
        `-- supabase/migrations/${arquivo}\n` +
        `-- ─────────────────────────────────────────────────────────────────────────\n\n`,
    );
    partes.push(await readFile(join(MIGRATIONS_DIR, arquivo), 'utf8'));
  }

  partes.push(BOOTSTRAP);

  const conteudo = partes.join('');
  await writeFile(SAIDA_BUNDLE, conteudo, 'utf8');

  console.log('gerado: scripts/sql/setup-completo.sql');
  console.log(`  ${conteudo.split('\n').length} linhas, ${kb(conteudo)}`);
  console.log('');

  // Recria o diretório do zero: uma migration renomeada deixaria o arquivo
  // antigo para trás, e alguém acabaria rodando um passo que não existe mais.
  await rm(SAIDA_PASSOS, { recursive: true, force: true });
  await mkdir(SAIDA_PASSOS, { recursive: true });

  console.log('gerado: scripts/sql/migracoes/');
  let passo = 1;

  for (const arquivo of arquivos) {
    const titulo = TITULOS[arquivo] ?? arquivo.replace(/^\d+_|\.sql$/g, '');
    const nome = `${String(passo).padStart(2, '0')}-${titulo}.sql`;
    const corpo =
      cabecalhoPasso(passo, arquivos.length + 1, titulo, DESCRICOES[arquivo], arquivo) +
      (await readFile(join(MIGRATIONS_DIR, arquivo), 'utf8'));

    await writeFile(join(SAIDA_PASSOS, nome), corpo, 'utf8');
    console.log(`  ${nome}`);
    passo += 1;
  }

  const nomeBootstrap = `${String(passo).padStart(2, '0')}-bootstrap-escritorio.sql`;
  await writeFile(
    join(SAIDA_PASSOS, nomeBootstrap),
    cabecalhoPasso(
      passo,
      arquivos.length + 1,
      'bootstrap do escritório',
      'Vincula seu usuário do Supabase Auth a um escritório, como owner.\n' +
        '-- EDITE as duas linhas marcadas com CONFIGURE antes de executar.',
      null,
    ) + BOOTSTRAP.replace(/^\n+/, ''),
    'utf8',
  );
  console.log(`  ${nomeBootstrap}`);
}

function cabecalhoPasso(
  passo: number,
  total: number,
  titulo: string,
  descricao: string | undefined,
  origem: string | null,
): string {
  return (
    `-- =============================================================================\n` +
    `-- audit — passo ${passo} de ${total}: ${titulo}\n` +
    `--\n` +
    (descricao ? `-- ${descricao}\n--\n` : '') +
    `-- ARQUIVO GERADO por \`npm run sql:bundle\`.` +
    (origem ? ` Origem: supabase/migrations/${origem}` : '') +
    `\n` +
    `-- Não edite aqui${origem ? ': altere a migration de origem' : ''}.\n` +
    `--\n` +
    `-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.\n` +
    `-- Pode rodar de novo sem duplicar nada.\n` +
    `-- =============================================================================\n\n`
  );
}

function kb(conteudo: string): string {
  return `${(Buffer.byteLength(conteudo) / 1024).toFixed(1)} KB`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
