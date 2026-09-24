# Plano de testes — substituição de mocks (Ondas 0 a 5 e correções)

> **Para quem é:** quem vai aceitar em ambiente real o que foi entregue entre
> 23 e 24/09/2026. A suíte automatizada já cobre a lógica de cada onda (1279
> testes, com o CI verde). Este plano cobre **o que só se prova no ambiente de
> verdade**: SEFAZ, Asaas, Anthropic, Render, Vercel e o banco de produção.

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

**Fora do escopo:** o que depende de API oficial ainda inexistente (formato
oficial da proposta do Fisco, Calculadora RFB, open finance) e os eventos de
manifestação além da ciência (210200, 210220, 210240).

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
export API=https://<servico-da-api>.onrender.com/v1      # ou http://localhost:3000/v1

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

**Esperado hoje:** tudo `ok`, com três avisos conhecidos:
- `cobrança (Asaas)`: modo só cálculo, até as chaves chegarem;
- `assistente só na camada 1`: sem `ANTHROPIC_API_KEY`;
- `prazos normativos`: só se o doctor ainda acusar.

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
| A1-3 | Flags do assistente refletem a configuração | `curl $API/assistant/capabilities` | Sem chave: `deterministic_only: true`, `language_model_configured: false`, sem `language_model` | ✅ |

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

Quando as chaves chegarem (`SEGREDOS.md`, seção Cobrança):

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

### Onda 4: assistente, camada 3 (⛔ até a `ANTHROPIC_API_KEY`)

Hoje:

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A4-1 | Pergunta da lista, camada 1 | Criar uma conversa e perguntar "quantas notas entraram?" | `tier: 1`, com citações | ✅ |
| A4-2 | Pergunta fora da lista, sem modelo | Perguntar "resuma a situação deste cliente" | `answerable: false`, "não há modelo de linguagem configurado", lista do que sabe | ✅ |

Com a chave (em dev, com chave de limite baixo):

| ID | Caso | Passos | Esperado | Auto |
|---|---|---|---|---|
| A4-3 | Capabilities com modelo | `curl $API/assistant/capabilities` | `language_model_configured: true`, `language_model: "claude-opus-5"` | ✅ |
| A4-4 | Resposta ancorada | Cliente com competência apurada; perguntar "resuma a situação deste cliente" | `tier: 3`, `confidence: medium`, cada `fact` com citações; valores iguais aos das consultas de camada 1 | 🟡 |
| A4-5 | Pergunta sem lastro | "qual a capital da França?" | `answerable: false` com motivo; nenhum fato | 🟡 |
| A4-6 | Valor inventado é barrado | Não dá para forçar o modelo a errar em produção: coberto pelo teste `tier3.test.ts` | — | ✅ |
| A4-7 | Cota conta a pergunta | `api $API/clients/$CNPJ/assistant/usage` antes e depois | `used` sobe 1 por pergunta, respondida ou não | ✅ |
| A4-8 | Custo | Painel da Anthropic depois de algumas perguntas | Cache de leitura (`cache_read_input_tokens`) acima de zero a partir da segunda pergunta | ⛔ |

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

O CI da PR roda os três, mais a imagem Docker respondendo `/health`.

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

## 7. Registro de execução

| ID | Data | Ambiente | Resultado | Observação |
|---|---|---|---|---|
| | | | | |

## 8. Se algo der errado

- **Coleta de DF-e com problema em produção:** não há chave de desligar. O
  caminho é reverter a #43 e fazer novo deploy. As tabelas `dfe_*` e as colunas
  novas ficam, porque são aditivas, e o upload manual continua funcionando.
- **Cobrança:** enquanto não houver `ASAAS_API_KEY`, nada é enviado ao gateway.
  Com chave, remover a variável do Doppler `prd` volta ao modo só cálculo.
- **Assistente:** remover `ANTHROPIC_API_KEY` volta à camada 1.
- **Migrations:** todas as desta entrega são aditivas ou só afrouxam restrições.
  Nenhuma precisa ser desfeita para reverter o código.
