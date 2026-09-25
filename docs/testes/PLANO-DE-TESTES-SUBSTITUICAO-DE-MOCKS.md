# Plano de testes — substituição de mocks (Ondas 0 a 5, segunda e terceira varreduras)

> **Para quem é:** quem vai aceitar em ambiente real o que foi entregue entre
> 23 e 25/09/2026. A suíte automatizada já cobre a lógica de cada entrega (1817
> testes na `main` em `0d5715f`). Este plano cobre **o que só se
> prova no ambiente de verdade**: SEFAZ, Asaas, Anthropic, SMTP, Render, Vercel
> e o banco de produção.

## 1. Escopo

| Entrega | PR | Onde está |
|---|---|---|
| Onda 0: `AUDIT_ENV` separa dev de prod | #30 | `src/config/env.ts` |
| Onda 1: cobrança sem parâmetros falha; flags do assistente derivadas | #32 | `billing.service.ts`, `assistant.routes.ts` |
| Onda 2: alíquota pela data do cenário | #34 | `simulation.service.ts` |
| Onda 2: NCMs monofásicos em `ncm_flags` (744) | #36 | `scripts/carregar-ncm-monofasico.ts` |
| Onda 3: ativação da cobrança e fatura pelo mês anterior | #37, #39 | `billing-activation.service.ts` |
| Onda 4: camada 3 do assistente (Claude) | #40 | `claude-language-model.ts`, `tier3.ts` |
| Onda 5: coleta de DF-e na SEFAZ (ADR-006) | #43 | `src/fiscal/dfe/` |
| Banco de teste por conjunto de migrations | #42 | `tests/setup/global-db.ts` |
| Chave de acesso com CNPJ alfanumérico | `fix/chave-alfanumerica` | `access-key.ts` + migration |
| **Segunda varredura**, A: configuração, limites e doctor | #57 | `env.ts`, `rate-limit.ts`, `environment-doctor.ts` |
| B: cancelamento de NF-e pela distribuição | #59 | `src/fiscal/dfe/dfe-events.ts` |
| C: EFD ICMS/IPI contra a lista de registros do guia | #68 | `icms-ipi-checks.ts`, `efd-icms-ipi-consolidacoes.ts` |
| D: a rota recusa o que o plano do CNPJ não inclui | #60 | `src/api/plugins/plan-gate.ts` |
| E: coleta agendada por opt-in (ADR-007) | #62 | `dfe-auto-sync.ts`, `dfe-worker.ts` |
| F: relatório do diagnóstico por e-mail | #65, front #30 | `readiness-delivery.ts`, `DiagnosticoReforma.tsx` |
| G: comprovante em PDF e validação do Conformidade Fácil | #67, front `feat/comprovante-em-pdf` | `integrity-proof.service.ts`, `conformidade-facil.client.ts` |
| **Terceira varredura**, índices oficiais de correção monetária | #79 | `index-sources.ts`, `index-loader.ts` |
| CLI `audit close` | #80 | `period-confirmation.service.ts`, `src/cli/audit.ts` |
| CAPAG presumida: demonstrativo, fórmula oficial da PGFN e planos | #81 a #84, front `feat/capag`, `feat/capag-fora-do-plano`, `fix/capag-formula-oficial`, `feat/capag-pj-inativa` | `src/fiscal/forensics/capag/`, `CapagDoCliente.tsx` |

**Fora do escopo:** o que depende de API oficial ainda inexistente (formato
oficial da proposta do Fisco, Calculadora RFB, open finance), os eventos de
manifestação além da ciência (210200, 210220, 210240), o leiaute 021 da EFD
ICMS/IPI e o limite de requisições distribuído (só com mais de uma instância).

## 2. Antes de começar: três regras

1. **O banco é o mesmo em dev e prod.** Tudo o que se faz aqui grava na base
   real. Crie um **escritório de teste** e trabalhe só nele. O event log é
   append-only: um evento gravado por engano não se apaga.
2. **A SEFAZ pune consulta repetida.** Depois de uma coleta que alcança a fila,
   a próxima só sai uma hora depois. Antes disso, a própria API responde 429.
   Não tente contornar: o 656 da SEFAZ bloqueia o CNPJ por uma hora.
3. **Nunca rode a suíte automatizada contra o banco de produção.** Ela usa o
   Postgres local (`localhost:55432`).

## 3. Preparação

```bash
# API em produção (Render) ou local (dev)
export API=https://audit-0wy2.onrender.com/v1      # ou http://localhost:3000/v1

# Token de um usuário owner do escritório de teste
export TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<owner-de-teste>","password":"<senha>"}' | jq -r .access_token)
alias api='curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"'

# CNPJ do cliente de teste (14 posições, sem máscara)
export CNPJ=<cnpj-de-teste>
```

Diagnóstico de partida, nos dois configs:

```bash
doppler run --project audit --config prd -- npm run doctor
doppler run --project audit --config dev -- npm run doctor
```

**Esperado hoje** (conferido em 25/09 contra `prd`): tudo `ok`, com os avisos
conhecidos:
- `cobrança (Asaas)`: modo só cálculo, até as chaves chegarem;
- `e-mail do diagnóstico`: sem os segredos do SMTP (ver `docs/todo_edilson.md`);
- `.env`: arquivo local, não diz respeito a `prd`;
- na linha das variáveis, `assistente camada 3 com claude-opus-5` em `prd`; em `dev`, sem chave, `assistente só na camada 1`.

Em `dev`, a linha `e-mail do diagnóstico` fica `ok` sem SMTP, como a cobrança
sem gateway.

Qualquer `FALHA` interrompe o plano.

## 4. Casos de teste

Legenda da coluna **Auto**:
- ✅ coberto na suíte automatizada;
- 🟡 coberto só com dublê (o serviço externo real não foi exercitado);
- ⛔ bloqueado por chave ou credencial que ainda não existe.

### Onda 0: ambientes

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A0-1 | Prod exige `AUDIT_ENV` | No Render, confirmar que o serviço subiu depois do deploy da #30; `curl $API/health` | `{"status":"ok"}` | ✅ |
| A0-2 | Doctor mostra o ambiente | `npm run doctor` em `prd` e em `dev` | Primeira linha: `ambiente prod` / `ambiente dev` | ✅ |
| A0-3 | Dev recusa Asaas de produção | Local: `AUDIT_ENV=dev ASAAS_API_KEY=x ASAAS_BASE_URL=https://api.asaas.com/v3 npm run serve` | Não sobe; mensagem "em dev, ASAAS_BASE_URL não pode apontar para o Asaas de produção" | ✅ |
| A0-4 | CORS em produção | No front da Vercel, abrir qualquer tela autenticada | Sem erro de CORS no console | — |
| A0-5 | CORS em dev | `curl -si -H 'Origin: https://sped-genius-hub.vercel.app' http://localhost:3000/v1/health` | Sem `access-control-allow-origin` (dev só libera `localhost:5173`) | ✅ |

### Onda 1: padrões perigosos

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A1-1 | Parâmetros de cobrança vêm do banco | `curl $API/plans` | `minimum_cents` igual a `billing_settings.minimum_cents` (15000) | ✅ |
| A1-2 | Sem `billing_settings`, 503 | **Só no Postgres local**: apagar a linha e chamar `/plans` | 503 `billing_not_configured`, apontando o doctor. **Não faça em produção.** | ✅ |
| A1-3 | Flags do assistente refletem a configuração | `curl $API/assistant/capabilities` | Em `prd`, com chave: ver A4-3. Local em `dev`, sem chave: `deterministic_only: true`, `language_model_configured: false`, sem `language_model` | ✅ |

### Onda 2: dados de referência

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A2-1 | Simulador consulta a alíquota do ano do cenário | `api -X POST $API/clients/$CNPJ/simulations -d '{"scenario":"full_2033","base_from":"2027-01","base_to":"2027-12"}'` (cliente com documentos no período) | Premissa `ibs_cbs_rate` com `origin: "provided"` e valor 26: não há alíquota de 2033 publicada | ✅ |
| A2-2 | NCM monofásico marcado | Classificar um item com `ncm: "30049045"`: `api -X PUT $API/clients/$CNPJ/items/<item>/classification -d '{"effective_from":"2027-11","ncm":"30049045"}'` | Resposta com `ncm_flags.monophasic: true` | ✅ |
| A2-3 | NCM fora da tabela não é marcado | Mesmo passo com `ncm: "30049046"` (a exceção da posição 30.04) | Sem `ncm_flags`, ou `monophasic: false` | ✅ |
| A2-4 | Contagem no doctor | `npm run doctor` (prd) | `tabelas oficiais de códigos … 744 NCM marcados` | ✅ |
| A2-5 | Carga idempotente | `doppler run --config dev -- npx tsx scripts/carregar-ncm-monofasico.ts` (simulação) | "744 NCMs monofásicos vigentes", sem erro de download (três tentativas no Planalto) | ✅ |

### Onda 3: cobrança (⛔ até as chaves do Asaas)

Hoje, em produção, só dá para validar o modo "só cálculo":

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A3-1 | Sem chave, a ativação diz por quê | `api -X POST $API/subscription/activate -d '{"document":"11.222.333/0001-81","email":"fin@teste.com","billing_type":"PIX"}'` | 503 `billing_gateway_not_configured` | ✅ |
| A3-2 | Doctor registra a pendência | `npm run doctor` (prd) | Aviso "modo só cálculo", com a lista de passos | ✅ |
| A3-3 | `/subscription` diz que não há cobrança | `api $API/subscription` | `billing_activated: false` | ✅ |

Quando as chaves chegarem (`docs/todo_edilson.md`, seção 1, e `docs/setup/SEGREDOS.md`, seção "O que `AUDIT_ENV` confere no start"):

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A3-4 | **Sandbox:** ajuste de valor da cobrança | API local com chaves de sandbox **só no processo**, contra o Postgres local. Ativar, e depois simular um `PAYMENT_CREATED` com valor diferente | O Asaas aceita `POST /payments/{id}` só com `value` (a única chamada nunca exercitada contra o gateway real) | ⛔ |
| A3-5 | Ativação real | Owner do escritório de teste ativa com CNPJ válido | 201; cliente e assinatura criados no painel do Asaas; `first_reference_month` é o primeiro mês cheio depois do trial | 🟡 |
| A3-6 | CPF/CNPJ inválido | Ativar com `11222333000182` | 400, sem nada criado no Asaas | ✅ |
| A3-7 | Reativar não duplica | Chamar a ativação duas vezes | 200 com `already_active: true`; um só cliente no painel | 🟡 |
| A3-8 | Webhook fecha a fatura | Aguardar o `PAYMENT_CREATED` real, ou reenviar pelo painel | Linha em `invoices` com `reference_month` = mês anterior ao vencimento, e snapshot da cotação | 🟡 |
| A3-9 | Mês sem CNPJ ativo | Escritório sem competência no mês de referência | Cobrança removida no Asaas; fatura `canceled` de R$ 0 | 🟡 |
| A3-10 | Pagamento marca a fatura | Pagar a cobrança de sandbox | `invoices.status = paid`; assinatura `active` | 🟡 |
| A3-11 | Reentrega do webhook | Reenviar o mesmo evento pelo painel | 200 `duplicate_ignored`; nada muda | ✅ |
| A3-12 | Cancelamento | `api -X POST $API/subscription/cancel -d '{"reason":"teste"}'` | Assinatura cancelada no Asaas e `status: canceled` | 🟡 |

### Onda 4: assistente, camada 3

A `ANTHROPIC_API_KEY` está no Doppler `prd` e a API no Render a recebeu (conferido em 25/09). Sem modelo, o assistente continua respondendo assim:

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A4-1 | Pergunta da lista, camada 1 | Criar uma conversa e perguntar "quantas notas entraram?" | `tier: 1`, com citações | ✅ |
| A4-2 | Pergunta fora da lista, sem modelo | Em ambiente sem a chave (o `dev` não tem), perguntar "resuma a situação deste cliente" | `answerable: false`, "não há modelo de linguagem configurado", lista do que sabe | ✅ |

Com a chave:

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A4-3 | Capabilities com modelo | `curl $API/assistant/capabilities` (rota pública) | `language_model_configured: true`, `language_model: "claude-opus-5"`. **Executado em 25/09 contra o Render: passou** | ✅ |
| A4-4 | Resposta ancorada | Cliente com competência apurada; perguntar "resuma a situação deste cliente" | `tier: 3`, `confidence: medium`, cada `fact` com citações; valores iguais aos das consultas de camada 1 | 🟡 |
| A4-5 | Pergunta sem lastro | "qual a capital da França?" | `answerable: false` com motivo; nenhum fato | 🟡 |
| A4-6 | Valor inventado é barrado | Não dá para forçar o modelo a errar em produção: coberto pelo teste `tier3.test.ts` | — | ✅ |
| A4-7 | Cota conta a pergunta | `api $API/clients/$CNPJ/assistant/usage` antes e depois | `used` sobe 1 por pergunta, respondida ou não | ✅ |
| A4-8 | Custo | Painel da Anthropic depois de algumas perguntas | Cache de leitura (`cache_read_input_tokens`) acima de zero a partir da segunda pergunta | — |

### Onda 5: coleta de DF-e na SEFAZ

**Pré-condições:**
- cliente de teste com **A1 real e válido**;
- `uf` preenchida (`api -X PATCH $API/clients/$CNPJ -d '{"uf":"SP"}'`);
- competência do mês atual aberta (`api -X POST $API/clients/$CNPJ/periods -d '{"period":"AAAA-MM"}'`).

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A5-1 | Certificado novo serve para coleta | Enviar o A1 pela tela ou por `PUT /clients/$CNPJ/certificate`; depois `api $API/clients/$CNPJ/certificate` | `usable_for_sync: true` | ✅ |
| A5-2 | Dev não coleta | Local em dev: `api -X POST http://localhost:3000/v1/clients/$CNPJ/sync` | 503 `dfe_gateway_not_configured` | ✅ |
| A5-3 | Sem UF | Cliente sem `uf`: `POST /sync` | 409 `dfe_missing_uf` | ✅ |
| A5-4 | **Primeira coleta real** | `api -X POST $API/clients/$CNPJ/sync`; acompanhar `api $API/jobs/<job_id>` até `done` (o worker toma o job em até ~15 s) | 202, e depois `status: done`. O `result` traz lotes, `ult_nsu` e `max_nsu` | 🟡 |
| A5-5 | mTLS e TLS | Conferir o A5-4 sem erro de TLS no log do Render | Nenhum erro de certificado. Se aparecer, a SEFAZ trocou de CA: ver ADR-006 | ⛔ |
| A5-6 | Log de uso do A1 | `api $API/clients/$CNPJ/certificate/usage` | Um `certificate.used` por lote (`dfe_distribution`) e por ciência (`manifestation`), com `actor` = quem pediu | ✅ |
| A5-7 | Notas de saída/terceiros completas | `api $API/clients/$CNPJ/dfe` e a lista de documentos | NF-e completas da competência aberta entram como documentos, com `doc.received` no log | 🟡 |
| A5-8 | Ciência das entradas | `api $API/clients/$CNPJ/dfe` | `summaries.awaiting_full_xml` > 0 depois da primeira coleta; `acknowledgement_failed` = 0 | 🟡 |
| A5-9 | Bloqueio de 1 hora | Repetir o `POST /sync` logo em seguida | 429 `dfe_sync_blocked`, com `retry_at` e `Retry-After` | ✅ |
| A5-10 | XML completo depois da ciência | **Uma hora depois**, nova coleta | As entradas manifestadas chegam completas; `awaiting_full_xml` cai | 🟡 |
| A5-11 | Competência não aberta | Se vier nota de mês não aberto: `GET /dfe` | `documents.awaiting_period_open` > 0; **nenhum** `output.rejected` no log. Abrir a competência e coletar depois do bloqueio: a nota entra | ✅ |
| A5-12 | Nota já subida à mão | Subir à mão um XML que a SEFAZ também vai trazer, antes da coleta | `result.already_present` ≥ 1; sem rejeição de duplicata no log | ✅ |
| A5-13 | Worker sobrevive a erro | No log do Render, nenhuma queda do processo depois de um job `failed` | Job `failed` com `error` legível; o próximo job é processado | ✅ |
| A5-14 | Certificado antigo | Cliente cujo certificado é anterior à #43 (`credential_format = pfx_protected`) | 409 pedindo reenvio | ✅ |

**Leitura de apoio (só leitura, no SQL Editor):**

```sql
select ult_nsu, max_nsu, last_cstat, last_motivo, blocked_until
  from dfe_sync_state where cnpj = '<cnpj>';
select access_key, manifest_cstat, manifested_at, received_at
  from dfe_summaries where cnpj = '<cnpj>' order by created_at desc limit 20;
select access_key, period, ingested_at, ingest_error
  from dfe_documents where cnpj = '<cnpj>' order by received_at desc limit 20;
```

### CNPJ e chave de acesso alfanuméricos

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| AC-1 | Cliente com CNPJ alfanumérico | Cadastrar um cliente de teste com CNPJ alfanumérico válido | 201 | ✅ |
| AC-2 | NF-e de emitente alfanumérico | Subir o XML de uma NF-e emitida por CNPJ alfanumérico | Aceita no 207, com a chave com letras em `accepted` | ✅ |
| AC-3 | Consulta pela chave | `api $API/clients/$CNPJ/documents/<chave-com-letras>` | 200 | ✅ |
| AC-4 | Assistente reconhece a chave | Perguntar "o que aconteceu com `<chave em grupos de 4>`?" | `intent: historico_do_documento` | ✅ |
| AC-5 | Restrição no banco | `select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.documents'::regclass and contype = 'c'` | Padrão `^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$` | ✅ |

### Segunda varredura, A (#57): configuração, limites e doctor

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SA-1 | Prod exige `TRUST_PROXY` | `npm run doctor` (prd) | Linha das variáveis: `IP do visitante pelo proxy (TRUST_PROXY)` | ✅ |
| SA-2 | Login limitado por IP e e-mail | Seis logins seguidos com senha errada para o e-mail de teste | O sexto responde 429 `rate_limited`, com `retry_after_seconds`; o login certo volta a funcionar depois do intervalo | ✅ |
| SA-3 | Calculadora limitada | 31 chamadas seguidas a `POST $API/price-calculator` | A 31ª responde 429 | ✅ |
| SA-4 | Quota do diagnóstico sem convite ao trial | Estourar a quota diária do diagnóstico (ou ler o teste) | 429 com o limite e quando tentar de novo, e nenhuma menção a trial ou plano | ✅ |
| SA-5 | Escada de faixas vigente | `curl $API/plans` | `tiers` é a escada de maior `effective_from` até hoje, inteira | ✅ |
| SA-6 | Faixas inválidas | **Só no Postgres local**: gravar escada não monotônica e chamar `/plans` | 503 `pricing_misconfigured`, e não 500 | ✅ |
| SA-7 | Ingestão pela CLI | `doppler run --config dev -- npx tsx src/cli/audit.ts ingest <pasta> --tenant <escritório de teste> --cnpj $CNPJ --actor <uuid>` | Resumo aceito/recusado, com `doc.received` no log do CNPJ de teste. **O banco é o de produção: só no escritório de teste** | ✅ |
| SA-8 | Doctor aponta arquivos que existem | Qualquer ação do doctor que cite `scripts/sql/migracoes/NN-…` | O arquivo citado existe | ✅ |

### Segunda varredura, B (#59): cancelamento de NF-e

**Pré-condição:** a coleta real da Onda 5 funcionando, e uma NF-e de entrada do
cliente de teste que o emitente vá cancelar (combine com um fornecedor, ou use
uma nota de teste da própria empresa emitida para o CNPJ).

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SB-1 | Cancelamento real aplicado | Coletar depois do cancelamento na SEFAZ | `result.cancellations` ≥ 1; `doc.cancelled` no log; a nota em `GET /documents` com `cancelled_at` | 🟡 |
| SB-2 | Cancelada sai das somas | Apurar a competência antes e depois do SB-1 | O ICMS da nota some dos totais; o comprovante traz `documents.cancelled` = 1 e o `total` sem ela | ✅ |
| SB-3 | Competência confirmada não muda | Cancelamento de nota de competência já confirmada | `GET /dfe` lista a nota em `cancellations_needing_rectification`; nenhum `output.rejected`; os totais confirmados não mudam | ✅ |
| SB-4 | Hash das projeções antigas intacto | Depois do deploy, `POST /clients/<cnpj de prd>/verify` e o comprovante de uma competência confirmada | `ok: true` e `confirmed_hash_reproduced: true`: o contador novo é opcional e não entra no hash de quem nunca teve cancelamento | ✅ |
| SB-5 | Evento sem vínculo | Evento com cStat 136, se aparecer | Guardado em `dfe_events` com `blocked_reason`, sem cancelar | ✅ |

```sql
select access_key, tp_evento, cstat, protocolo, applied_at, blocked_reason
  from dfe_events where cnpj = '<cnpj>' order by received_at desc limit 20;
```

### Segunda varredura, C (#68): EFD ICMS/IPI

**Pré-condição:** a EFD ICMS/IPI real de um cliente de Lucro Real (leiaute 019
ou 020), de preferência uma com conta de energia (C500) e CT-e (D100).

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SC-1 | A soma contra o E110 roda | Importar a EFD (`POST /clients/$CNPJ/efd-icms-ipi`) e ler `GET /icms-ipi-reconciliation/<período>` | `c190-vs-e110-debitos` e `-creditos` `passed` ou `failed` com valores; nunca `not_verified` por causa de `C990`, `D001` ou `D990` (o bug corrigido) | ✅ |
| SC-2 | Energia e transporte entram | Mesma EFD, com C590 e D190 | `expectedCents` inclui o ICMS deles; a diferença, se houver, bate com o que o PVA mostra | 🟡 |
| SC-3 | Registro ainda não somado | EFD de varejo com C850 (CF-e SAT) | Débitos `not_verified` citando C850; créditos conferidos | ✅ |
| SC-4 | Arquivo importado antes da #68 | Uma EFD importada antes do deploy | Continua `not_verified` onde tinha registro não lido; reimportada, passa a ser conferida | ✅ |
| SC-5 | Rótulo do plano | `curl $API/plans` | `sped_completo` fala em leiautes 019 e 020 | ✅ |

### Segunda varredura, D (#60): o que o plano inclui

Mudar o regime de um cliente em produção muda a fatura dele. **Só no
escritório de teste.**

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SD-1 | Plano completo passa | Cliente `lucro_real`: apuração, contra-apuração, crédito em risco, dossiê, EFD | Nenhum 403 | ✅ |
| SD-2 | Fora do plano, 403 com os planos | Cliente de teste em `mei`: `api $API/clients/$CNPJ/assessments/AAAA-MM` | 403 `feature_not_in_plan`, com `feature: apuracao_dual`, `regime: mei` e `plans_with_feature` | ✅ |
| SD-3 | A base continua aberta | Mesmo cliente MEI: documentos, competências, eventos, Book | Nenhum 403 | ✅ |
| SD-4 | White label pela tabela | Book com `white_label: true` num cliente `simples_hibrido` | 403 `feature_not_in_plan` (`white_label`) | ✅ |
| SD-5 | Calendário da carteira | Escritório só com MEI: `api $API/deadlines` | 403 (`calendario`); com um CNPJ de plano maior na carteira, 200 | ✅ |
| SD-6 | CNPJ de outro escritório | Chamar uma rota fechada com CNPJ que não é da carteira | 404, e não 403 | ✅ |
| SD-7 | A tela diante do 403 | No front, abrir a apuração, a contra-apuração e o crédito em risco do cliente MEI | Aviso "… não está no plano deste CNPJ", com o nome do recurso como na tabela de preço, os planos que o incluem e o atalho para Plano e assinatura; sem cara de erro, e em menos de um segundo (sem retry). Front: `feat/fora-do-plano` | — |

### Segunda varredura, E (#62): coleta agendada

**Pré-condição:** a primeira coleta real (A5-4) já feita, e o A1 do cliente de
teste em `pem_bundle` (`usable_for_sync: true`).

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SE-1 | Dev não liga | Local em dev: `api -X PUT http://localhost:3000/v1/clients/$CNPJ/dfe/auto -d '{"enabled":true}'` | 503 `dfe_gateway_not_configured`: o banco de dev é o de produção | ✅ |
| SE-2 | Só o owner | O mesmo `PUT` em prd com token de `accountant` ou `viewer` | 403 | ✅ |
| SE-3 | Ligar em prd | Owner: `api -X PUT $API/clients/$CNPJ/dfe/auto -d '{"enabled":true}'` | 200 com `auto_sync.enabled_by` = owner; `client.updated` com `dfe_auto_sync: true` no log | ✅ |
| SE-4 | O agendador enfileira sozinho | Esperar o fim do bloqueio de uma hora e mais até 10 min | Job novo com `trigger = 'schedule'`, `requested_by` nulo, terminando `done` | 🟡 |
| SE-5 | Autoria no log de uso | `api $API/clients/$CNPJ/certificate/usage` | Usos do job agendado com `actor: closer`, `triggered_by: schedule` e `enabled_by`; os manuais com `triggered_by: manual` | ✅ |
| SE-6 | Ritmo sem punição da SEFAZ | Deixar ligado por um dia | No máximo uma coleta por hora; `dfe_sync_state.last_cstat` nunca `656` | 🟡 |
| SE-7 | Desligar vale na hora | `PUT … {"enabled":false}` com um job agendado na fila | O job falha com "desligada", sem `certificate.used`; nenhum job novo depois | ✅ |
| SE-8 | Processo estável | Log do Render ao longo do dia | Nenhum erro `agendador da coleta de DF-e` | — |

```sql
select trigger, requested_by, status, error, created_at, finished_at
  from jobs where cnpj = '<cnpj>' and kind = 'dfe_sync' order by created_at desc limit 20;
```

### Segunda varredura, F (#65): relatório do diagnóstico por e-mail (⛔ até os segredos)

Hoje, sem os segredos:

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SF-1 | Nada guardado sem a chave | Fazer um diagnóstico na tela pública | Resposta com `persisted: { documents: false, summary_until: null }` | ✅ |
| SF-2 | Lead sem envio, dito na tela | Pedir a cópia por e-mail | Lead gravado; a tela diz que o envio automático ainda não está ligado (`mail_not_configured`), e não "a cópia vai para…" | ✅ |
| SF-3 | Doctor avisa | `npm run doctor` (prd) | Aviso `e-mail do diagnóstico`, com a lista de segredos | ✅ |

Com os segredos (`docs/todo_edilson.md`, seção 1, e-mail do diagnóstico):

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SF-4 | Resumo guardado por 24h | Diagnóstico na tela | `summary_until` ≈ agora + 24h; a tela diz até quando o resumo fica guardado | ✅ |
| SF-5 | E-mail chega com o PDF | Pedir a cópia para uma caixa sua (Gmail e Outlook) | E-mail na caixa de entrada, não no spam; PDF abre e os números batem com a tela | ⛔ |
| SF-6 | Remetente autenticado | No Gmail, "Mostrar original" | `SPF: PASS` e `DKIM: PASS` para o domínio do `MAIL_FROM` | ⛔ |
| SF-7 | Resumo apagado depois do envio | SQL abaixo | `report_ciphertext` nulo e `email_sent_at` preenchido | ✅ |
| SF-8 | Link de remoção | Abrir o link do e-mail; abrir de novo | Primeira vez: página "o seu e-mail foi apagado", e `email` nulo; segunda: página de link inválido (404) | ✅ |
| SF-9 | Relatório vencido | Pedir a cópia de um diagnóstico com mais de 24h | 410; a tela pede para gerar de novo; nenhum e-mail gravado | ✅ |
| SF-10 | Falha do SMTP | Com senha errada no `MAIL_SMTP_URL`, pedir a cópia | Lead gravado, `email_sent: false` (`send_failed`), motivo em `email_error`, e aviso no doctor | ✅ |
| SF-11 | Exportação dos leads | `doppler run --project audit --config prd -- npx tsx scripts/exportar-leads.ts > leads.csv` | CSV com e-mail, consentimento, origem e envio; nenhuma coluna do relatório | — |

```sql
select created_at, email is not null as tem_lead, report_expires_at,
       report_ciphertext is not null as guardado, email_sent_at, email_error
  from readiness_reports order by created_at desc limit 10;
```

### Segunda varredura, G (#67): comprovante em PDF e Conformidade Fácil

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| SG-1 | PDF do comprovante | `curl -s -D h.txt -o c.pdf -H "Authorization: Bearer $TOKEN" "$API/clients/$CNPJ/periods/AAAA-MM/proof?format=pdf"`, depois `sha256sum c.pdf` e `grep -i x-pdf-sha256 h.txt` | Os dois SHA-256 iguais; o PDF abre, com o hash **inteiro** no rodapé de todas as páginas | ✅ |
| SG-2 | Mesmos números do JSON | Comparar o PDF com `GET …/proof` | Documentos, eventos, hashes e veredito iguais | ✅ |
| SG-3 | Só leitura | Contar os eventos do CNPJ antes e depois de baixar | Iguais | ✅ |
| SG-4 | Botão no front | Tela do comprovante → "Baixar PDF" | Arquivo `comprovante-<cnpj>-<período>.pdf` baixado; o SHA-256 aparece ao lado, copiável | — |
| SG-5 | Validador aceita a tabela real | `doppler run --config dev -- npx tsx scripts/carregar-classificacao-ibs-cbs.ts --portal` (simulação, não grava) | "18 CST(s), 164 cClassTrib" e a amostra, sem erro de formato. **Executado em 25/09: passou** | ✅ |
| SG-6 | API da SVRS com mTLS | Com o A1 da operação em `CFF_CERT_PFX`/`CFF_CERT_PASSWORD`, o mesmo script sem `--portal` | Mesmas contagens do SG-5 | ⛔ |

### Terceira varredura, índices oficiais (#79)

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| TI-1 | Carga conferida | `doppler run --config prd -- npx tsx scripts/carregar-indices-oficiais.ts` (simulação) | Os cinco índices com 386 competências (1994-07 a 2026-08) e "conferida". **Executado em 25/09 com `--executar`: passou** | ✅ |
| TI-2 | Catálogo carregado | `api $API/financial-indices` | `loaded_count: 5`, todos `verified: true` | ✅ |
| TI-3 | Fator não nulo | `api "$API/financial-indices/ipca/factor?from=2025-01&to=2025-12"` | Fator numérico com a fonte citada, nunca `null` | ✅ |
| TI-4 | Doctor | `npm run doctor` (prd) | "índices financeiros" ok. **Executado em 25/09: passou** | ✅ |
| TI-5 | Atualização mensal | Depois do dia 15 do mês seguinte, repetir o TI-2 | Última competência avança um mês sem ninguém rodar o script | 🟡 |

### Terceira varredura, CLI `audit close` (#80)

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| TC-1 | Fecha com o hash conferido | Pegar o `projection_hash` da competência do escritório de teste na tela; `doppler run --config prd -- npx tsx src/cli/audit.ts close AAAA-MM --tenant … --cnpj $CNPJ --actor … --hash <hash>` | Confirmada; `GET …/proof` com `confirmed_hash_reproduced: true` | ✅ |
| TC-2 | Hash divergente | O mesmo com um hash qualquer | Recusa, sem evento novo no log | ✅ |

### Terceira varredura, CAPAG presumida (#81 a #84)

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| TK-0 | Extrator com o modelo real | Demonstrativo de exemplo da suíte (`tests/helpers/capag.ts`) pelo `ClaudeCapagExtractor` com a chave de `prd`, sem gravar | `reproduces: true`, `verified: true`, `problems: []`, faixa C, CAPAG de R$ 950.000,00. **Executado em 25/09: passou, em 10 s** | ✅ |
| TK-1 | Fórmula oficial carregada | `npm run doctor` (prd) | "CAPAG": 5 grupos com a oficial da PGFN conferida, extrator configurado. **Executado em 25/09: passou** | ✅ |
| TK-2 | Oficial antes da doutrina | `api $API/clients/$CNPJ/capag` (cliente em `simples_hibrido`, `lucro_presumido` ou `lucro_real`) | `reference_formulas` com os cinco grupos, `source_kind: oficial_pgfn` e `verified: true`; PJ fora do Simples com `0.5` em V6 | ✅ |
| TK-3 | Doutrina nunca conferida | SQL Editor: `update capag_reference_formulas set verified = true where source_kind = 'doutrina';` | Recusado por `capag_referencia_conferida_so_oficial` | ✅ |
| TK-4 | Tela | Detalhe do cliente → CAPAG | Selo "Oficial (PGFN), conferida" em cada fórmula; grupos com rótulo em português | — |
| TK-5 | Fora do plano | Cliente `mei` ou `simples_integrado` → CAPAG | Tela "fora do plano", com os planos que incluem; a API responde 403 `feature_not_in_plan` | ✅ |
| TK-6 | Demonstrativo real (**pendente, aguarda documento**) | Baixar do REGULARIZE o PDF original de um cliente de teste e enviar pela tela | `reproduces: true`, `verified: true`, `problems: []`; a CAPAG calculada igual à impressa (tolerância de R$ 1) | 🟡 |
| TK-7 | Documento que não confere | Enviar um PDF digitalizado (imagem) | 400 dizendo que o PDF parece digitalizado; o modelo não é chamado e nada é gravado | ✅ |
| TK-8 | Limite por hora | 11 envios em uma hora pelo mesmo escritório | O 11º responde 429 | ✅ |

### Banco de teste por schema (desenvolvimento)

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| AT-1 | Suíte local verde | `TEST_DATABASE_URL=postgres://audit:audit@localhost:55432/audit_test npm test` | Todos passam; o dossiê incluído | ✅ |
| AT-2 | Um banco por schema | `psql … -c '\l audit_test*'` depois de rodar em duas branches com migrations diferentes | Um `audit_test_<hash>` por conjunto de migrations | ✅ |

## 5. Regressão automatizada

Antes de cada aceite, e depois de qualquer correção:

```bash
npm run lint && npm run build
TEST_DATABASE_URL=postgres://audit:audit@localhost:55432/audit_test npm test
npx --yes @redocly/cli@latest lint docs/api/openapi.yaml
```

O CI da PR roda os três, mais a imagem Docker respondendo `/health`. O lint
do Redocly falha por erro, não por aviso: a `main` tem 62 avisos conhecidos
(licença, servidor de exemplo, operações sem 4xx) e zero erros.

**Intermitência conhecida (resolvida):** `tax_rules` é global e disputada por
arquivos em paralelo. O teste "devido não determinável" foi isolado na #43. Se
outro teste que depende de regra publicada passar a oscilar, a causa provável
é a mesma.

## 6. Critério de aceite

- Todos os casos **✅** e **🟡** sem bloqueio passam.
- Os casos **⛔** ficam registrados como pendentes, com a chave ou credencial
  que falta.
- A primeira coleta real (A5-4 a A5-10) sai sem nenhum `output.rejected`
  inesperado no log do cliente de teste.
- Um dia de coleta agendada (SE-4 a SE-6) sem nenhum `656` da SEFAZ.
- Depois de cada deploy, o comprovante de uma competência já confirmada em
  produção continua com `confirmed_hash_reproduced: true` (SB-4).
- A CAPAG só vale como aceita depois do TK-6, com um demonstrativo real do
  REGULARIZE reproduzindo a CAPAG impressa.

## 7. Registro de execução

| ID | Data | Ambiente | Resultado | Observação |
|---|---|---|---|---|
| A2-4 | 25/09/2026 | prd | passou | doctor: "tabelas oficiais de códigos" ok |
| SG-5 | 25/09/2026 | dev | passou | 18 CST, 164 cClassTrib |
| TI-1, TI-4 | 25/09/2026 | prd | passou | 386 competências por índice, todas conferidas |
| A4-3 | 25/09/2026 | prd (Render) | passou | `language_model: claude-opus-5` |
| TK-0 | 25/09/2026 | prd (chave), sem gravar | passou | demonstrativo de exemplo reproduzido em 10 s |
| TK-1 | 25/09/2026 | prd | passou | 5 grupos com a fórmula oficial conferida |
| | | | | |

## 8. Se algo der errado

- **Coleta de DF-e com problema em produção:** não há chave de desligar. O
  caminho é reverter a #43 e fazer novo deploy. As tabelas `dfe_*` e as colunas
  novas ficam, porque são aditivas, e o upload manual continua funcionando.
- **Cobrança:** enquanto não houver `ASAAS_API_KEY`, nada é enviado ao gateway.
  Com chave, remover a variável do Doppler `prd` volta ao modo só cálculo.
- **Assistente:** remover `ANTHROPIC_API_KEY` volta à camada 1.
- **Coleta agendada:** desligar por cliente (`PUT /dfe/auto {"enabled":false}`)
  ou todos de uma vez, pelo SQL Editor:
  `update clients set dfe_auto_sync = false where dfe_auto_sync;`. O job que
  já estiver na fila falha sem usar o certificado.
- **E-mail do diagnóstico:** remover `MAIL_SMTP_URL` volta a só gravar o lead.
  O diagnóstico inteiro tem killswitch: `PUBLIC_DIAGNOSTIC_ENABLED=false`.
- **Features do plano:** não há chave de desligar. O caminho é reverter a #60.
- **CAPAG:** remover `ANTHROPIC_API_KEY` faz o envio de demonstrativo responder
  503; a leitura continua. Fórmula de referência errada sai com
  `delete from capag_reference_formulas where formula_id = '…';`, e o buscador
  grava de novo.
- **Migrations:** todas as desta entrega são aditivas ou só afrouxam restrições.
  Nenhuma precisa ser desfeita para reverter o código.
