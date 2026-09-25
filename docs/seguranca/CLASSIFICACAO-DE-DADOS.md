# Classificação de dados

O que este sistema guarda, sob que regime, e o que isso obriga. Serve a duas
perguntas que chegam juntas: a do cliente ("que dado meu vocês têm?") e a da
auditoria ("como vocês sabem?").

Escrito a partir do schema, e não de um modelo: a tabela do fim cobre **todas**
as tabelas do banco, conferidas contra `information_schema`. Tabela nova sem
classe é lacuna, não omissão.

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
| `projection_snapshots` | Fiscal sigiloso | Derivado do log; o `projection_hash` é o que o cliente vê e `POST /verify` recalcula |
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
| `jobs` | Operacional | Fila de trabalho assíncrono |

## O que não está no banco

- **A chave mestra do cofre** — Doppler, config `prd`. Ver [`SEGREDOS.md`](../setup/SEGREDOS.md).
- **E-mail e senha dos usuários** — `auth.users`, do Supabase. A API só lê o id do
  token; o e-mail aparece em `GET /v1/users` quando o schema `auth` está
  acessível, e a rota declara quando não está.
- **O PFX em claro** — existe apenas em memória, durante o uso, e nunca é escrito.
