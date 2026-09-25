# Classificação de dados

O que este sistema guarda, sob que regime, e o que isso obriga. Serve a duas
perguntas que chegam juntas: a do cliente ("que dado meu vocês têm?") e a da
auditoria ("como vocês sabem?").

Escrito a partir do schema **de produção**, e não de um modelo nem do banco de
teste. A distinção custou caro: a primeira versão deste documento dizia cobrir
"todas as tabelas do banco" e foi conferida contra o banco de teste, que só tem o
que as migrations criam. Produção tinha 22 objetos a mais, herdados da fase
anterior do produto — e um deles servia nota fiscal à chave pública. Tabela nova
sem classe é lacuna, não omissão, e a conferência é contra produção.

## As classes

| Classe | O que é | O que obriga |
|---|---|---|
| **Segredo** | Material criptográfico e credencial. Hoje: o PFX cifrado do certificado A1 e a chave mestra que o decifra | A chave mestra nunca no banco nem no repositório (fica no Doppler); o PFX **nunca sai da API** — não existe rota de download, e a ausência é o controle; todo uso emite `certificate.used` |
| **Fiscal sigiloso** | Tudo que descreve operação, apuração ou documento do contribuinte. Protegido pelo art. 198 do CTN, que é anterior e independente da LGPD | Isolamento por `(tenant_id, cnpj)` no código e RLS como segunda tranca; nunca sai do escopo do escritório; o event log é append-only |
| **Pessoal** | Identifica pessoa natural: e-mail e id de usuário, autor de cada evento, nome de escritório que seja empresário individual | Base legal é a execução do contrato com o escritório; entra na conta da retenção e do descarte, que é a lacuna aberta |
| **Comercial** | Relação do escritório conosco: plano, assinatura, fatura | Sem sigilo fiscal, mas é dado de cliente. Vive **fora** do event log de propósito: o log é trilha de defesa perante o Fisco e não deve carregar cobrança |
| **Referência pública** | Tabelas oficiais de códigos e regras. NCM, CFOP, CST, cClassTrib, alíquotas, prazos | Nenhuma restrição. São públicas na origem, e a cópia existe por disponibilidade e por vigência datada |
| **Operacional** | Estado de execução: fila de trabalho, ponteiro de sincronização | Sem dado de conteúdo. Referencia escopo, e por isso é escopado igual |

## Duas coisas que a classificação torna explícitas

**O sigilo fiscal é mais restritivo que a LGPD, e vem antes.** A maior parte do
que guardamos é de pessoa jurídica, então a LGPD nem se aplica à maior parte do
acervo — mas o art. 198 do CTN se aplica a tudo. Tratar o acervo como "dado de
empresa, logo menos sensível" seria o erro.

**Apagar dado pessoal esbarra na arquitetura, não na rotina.** O event log é
append-only por decisão de produto: é o que sustenta a afirmação de que o número
deriva daqueles documentos. Um pedido de exclusão que alcance o `actor` de um
evento não se resolve com um `delete`. Está registrado como lacuna aberta em
[`CONTROLES.md`](CONTROLES.md), e precisa de decisão antes de virar procedimento.

## Onde cada tabela cai

| Tabela | Classe | Nota |
|---|---|---|
| `certificates` | Segredo | `encrypted_pfx` cifrado em AES-256-GCM; `key_id` diz qual chave mestra cifrou |
| `events` | Fiscal sigiloso + Pessoal | O `payload` é fiscal; o `actor` é pessoal. Append-only por gatilho |
| `clients` | Fiscal sigiloso | CNPJ, regime, UF. Identifica o contribuinte |
| `periods` | Fiscal sigiloso | |
| `documents`, `document_items` | Fiscal sigiloso | NF-e recebidas e emitidas, item a item |
| `dfe_documents`, `dfe_summaries` | Fiscal sigiloso | Coleta na SEFAZ |
| `dfe_sync_state` | Operacional | Ponteiro de NSU |
| `items`, `item_classifications` | Fiscal sigiloso | Cadastro de item e classificação com vigência |
| `assessments`, `assessment_lines`, `assessment_adjustments`, `assessment_divergences` | Fiscal sigiloso | Apuração dual |
| `fisco_assessments`, `fisco_assessment_lines` | Fiscal sigiloso | Proposta do Fisco, para contra-apuração |
| `sped_files`, `sped_documents`, `sped_carried_credits` | Fiscal sigiloso | EFD-Contribuições e o saldo credor |
| `efd_icms_documents`, `efd_icms_assessments` | Fiscal sigiloso | EFD ICMS/IPI |
| `bank_statements`, `bank_statement_lines`, `payment_matches` | Fiscal sigiloso | Extrato é informação fiscal nesta aplicação: liquidação decide o crédito |
| `books`, `audit_trails`, `readiness_reports` | Fiscal sigiloso | Entregáveis e achados |
| `simulations` | Fiscal sigiloso | Cenários sobre a projeção do CNPJ |
| `deadlines` | Fiscal sigiloso | Prazos da carteira |
| `assistant_threads`, `assistant_messages` | Fiscal sigiloso + Pessoal | Guardam a pergunta escrita pelo contador e as evidências citadas |
| `tenants` | Pessoal | Nome do escritório; pode ser empresário individual |
| `memberships` | Pessoal | Liga `auth.users` ao escritório, com o papel |
| `subscriptions`, `invoices`, `billing_events`, `billing_settings` | Comercial | Fora do event log de propósito |
| `plans`, `plan_features`, `pricing_tiers` | Comercial (público) | Catálogo; a calculadora de preço é pública |
| `fiscal_codes`, `cclasstrib_cst`, `ncm_flags` | Referência pública | NCM, NBS, CFOP, CST, cClassTrib |
| `tax_rules`, `deadline_rules` | Referência pública | Alíquotas e prazos normativos, com vigência |
| `audit_executions`, `audit_findings`, `audit_reversals` | Fiscal sigiloso | Auditoria contínua: execuções, achados e reversões |
| `evaluation_criteria` | Referência pública | Critérios de avaliação da auditoria |
| `dfe_events` | Fiscal sigiloso | Eventos de DF-e vindos da SEFAZ |
| `security_events` | Pessoal + Operacional | Trilha de autenticação, autorização e limite. Guarda **HMAC** do IP e do e-mail tentado, nunca os valores. Fora do event log: aquele é prova fiscal, este é investigação |
| `jobs` | Operacional | Fila de trabalho assíncrono |

## Legado: o que existe em produção e nenhuma migration cria

Vinte e dois objetos sobraram da fase anterior do produto. Nenhuma migration os
cria, nenhum código dos dois repositórios os lê, e **dezoito deles têm dado**.

| Objeto | Classe | Linhas em 25/09/2026 |
|---|---|---|
| `extracted_invoices`, `extracted_items`, `extracted_taxes`, `extracted_participants`, `extracted_companies` | Fiscal sigiloso | 946, 420, 192, 99, 1 |
| `xml_documents`, `xml_document_items`, `xml_import_jobs` | Fiscal sigiloso | 193, 613, 3 |
| `sped_parsed_records`, `sped_parsing_jobs` | Fiscal sigiloso | 1499, 1 |
| `cross_reference_results`, `cross_reference_divergences`, `cross_reference_runs` | Fiscal sigiloso | 193, 414, 1 |
| `sped_invoices_for_crossref` (**view**) | Fiscal sigiloso | 192 — **respondia à chave pública**, ver abaixo |
| `uploaded_files`, `entity_extraction_jobs`, `document_cache` | Operacional | 2, 2, 0 |
| `profiles` | Pessoal | 3 |
| `cfops` | Referência pública | 238 |
| `ai_analyses`, `audits`, `reports` | Fiscal sigiloso | 0, 0, 0 |

**A view vazava.** `sped_invoices_for_crossref` devolvia `200` e 192 notas reais
— com CNPJ do emitente, número, série e data — para a chave anon, que é pública
por construção e vai no pacote do frontend. View não tem RLS e, por padrão, roda
com o privilégio de quem a definiu, atravessando a RLS das tabelas de origem. A
correção está em `32-view_exposta_ao_anon.sql`, e o `npm run doctor` passou a
medir isso assumindo o papel `anon` e contando linhas — que é o que o PostgREST
faz ao atender a chave.

**O resto continua aberto como decisão.** Este dado é de clientes reais e está
fora do modelo de isolamento por `(tenant_id, cnpj)` do produto atual. As opções
são migrar, arquivar ou apagar, e nenhuma é técnica: apagar dado fiscal de
cliente é decisão de negócio. Está registrado em
[`CONTROLES.md`](CONTROLES.md).

## O que não está no banco

- **A chave mestra do cofre** — Doppler, config `prd`. Ver [`SEGREDOS.md`](../setup/SEGREDOS.md).
- **E-mail e senha dos usuários** — `auth.users`, do Supabase. A API só lê o id do
  token; o e-mail aparece em `GET /v1/users` quando o schema `auth` está
  acessível, e a rota declara quando não está.
- **O PFX em claro** — existe apenas em memória, durante o uso, e nunca é escrito.
