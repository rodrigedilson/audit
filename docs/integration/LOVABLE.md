# Passo a passo — migrar o `sped-genius-hub` para ser o front do `audit`

O frontend **já existe e está em produção**: `sped-genius-hub`, projeto Lovable,
publicado em <https://sped-genius-hub.vercel.app>. Este documento é o plano de
migração para ele passar a consumir a API do `audit` e o Supabase atual
(`uflputiyytswvagrrzzn`).

Não é plano de construção. O que precisa ser construído já está construído — o
trabalho é **trocar a fonte do dado fiscal** sem perder o que funciona.

| Fonte da verdade | Onde |
|---|---|
| Contrato da API | [`docs/api/openapi.yaml`](../api/openapi.yaml) — v1.0.0 |
| Regras de cada tela | [`TELAS.md`](TELAS.md) — 16 telas |
| Design system | [`design-system/lovable/`](../../design-system/lovable/) |
| Frontend | `rodrigedilson/sped-genius-hub` |

---

## O ponto de partida real

O `sped-genius-hub` não é uma casca vazia. Ele tem:

- **17 páginas**, autenticação funcionando, AppShell, upload com drag-and-drop
- **5 features organizadas em pasta própria, com hooks** — o que torna a
  migração tratável: troca-se o hook, não a tela
- **36 arquivos de 177** tocam o Supabase. O acoplamento é menor do que parece
- **22 tabelas e 14 edge functions** no projeto `rzzohjzfgfefuceardxe`
- **Nenhum teste automatizado**

E o `audit` tem o mesmo domínio implementado por outro caminho: 7 camadas de
validação, event log append-only, single-writer por CNPJ, hash de projeção
verificável e 930 testes.

**A decisão que orienta tudo abaixo:** onde os dois fazem a mesma coisa, o
`audit` ganha — não por ser mais novo, mas porque é ele que tem a trilha de
defesa. Onde só o `sped-genius-hub` faz, ele fica.

---

## Passo 1 — Deploy da API do `audit` (bloqueio duro)

**Isto é primeiro e não tem desvio.** O frontend em produção roda no navegador a
partir de `sped-genius-hub.vercel.app`, e esse navegador precisa alcançar a API.
`localhost` não serve. E o repositório do backend **não tem configuração de
deploy** — só CI.

### O que já está pronto

O [`Dockerfile`](../../Dockerfile) e o [`.dockerignore`](../../.dockerignore)
existem e estão verificados. Imagem multi-stage, **389 MB**, usuário sem
privilégio, `dumb-init` como PID 1 e healthcheck em `/v1/health`.

Verificado rodando o contêiner de fato, não só buildando:

| Checagem | Resultado |
|---|---|
| `GET /v1/health` | `{"status":"ok"}` |
| `GET /v1/plans` (toca o banco) | devolve os 5 planos semeados |
| `GET /v1/clients` sem token | `401` |
| Healthcheck do Docker | `healthy` |
| CORS com a origem da Vercel | `access-control-allow-origin` devolvido |
| CORS com origem não listada | **sem** o header — o navegador bloqueia |
| `docker stop` | exit `0` em 0,08s, com `app.close()` |

O [job `image` do CI](../../.github/workflows/ci.yml) repete isso a cada PR:
sobe o contêiner contra um Postgres e exige resposta em `/v1/health`. Existe
porque o `tsc` não vê leitura de disco — uma dependência de runtime fora de
`src/` passa por lint, build e 930 testes e só quebra no deploy. Foi o que
aconteceu ao escrever este passo: o servidor carrega `config/esaa.config.yaml`
no start para montar o `AGENT_CONTRACT` da camada 5, e a primeira versão da
imagem não copiava `config/`.

Para rodar local:

```bash
docker build -t audit-api .
docker run -p 3000:3000 --env-file .env audit-api
```

### O que falta

Escolher o provedor e subir. Qualquer um que aceite `Dockerfile` serve (Fly,
Render, Railway, Cloud Run). Variáveis no serviço de deploy:

```bash
DATABASE_URL=postgresql://...        # pooler do Supabase (npm run pooler descobre o host)
SUPABASE_URL=https://uflputiyytswvagrrzzn.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_JWT_SECRET=...              # ou SUPABASE_JWKS_URL
CERTIFICATE_MASTER_KEY=...           # ← em SECRET MANAGER, não em variável de painel
CORS_ORIGINS=https://sped-genius-hub.vercel.app,http://localhost:5173
API_PORT=3000
```

Três coisas que vão morder se passarem batido:

1. **`CORS_ORIGINS` não aceita curinga.** É lista de origens exatas, de propósito
   (ver o comentário em [`env.ts`](../../src/config/env.ts)). A URL da Vercel
   entra literal. Se você usar preview deploys da Vercel, cada URL de preview é
   uma origem diferente — nesses, use o frontend local contra a API deployada.
2. **`CERTIFICATE_MASTER_KEY` em secret manager.** Rotacioná-la torna ilegível
   todo certificado A1 já armazenado. Variável de painel de deploy não é lugar
   para ela.
3. **Conferir antes de apontar o front:** `npm run doctor` contra o ambiente de
   produção deve dar 34 tabelas e 10 funções. É o que prova que as 13 migrações
   chegaram inteiras.

**Esforço restante: 2–4h** (era 8–12h; o `Dockerfile`, o `.dockerignore` e a
verificação no CI já estão feitos).

---

## Passo 2 — Migrar o dado fiscal do front para o event log

**Existe um só projeto Supabase** (`uflputiyytswvagrrzzn`), e os dois schemas já
estão nele — verificado: 69 tabelas no `public`, as 34 do `audit` e as 22 do
front, sem colisão de nome. O `rzzohjzfgfefuceardxe` que aparece no `.env` local
do front é resíduo; o `client.ts` já tem fallback para o projeto certo.

Então **não há migração entre projetos**. O que há é dado do front que a API do
`audit` não conhece:

| Tabela | Linhas | O que é |
|---|---|---|
| `xml_documents` | 193 | NF-e, **com o XML original em `raw_xml`** |
| `xml_document_items` | 613 | itens dessas notas |
| `sped_parsed_records` | 1.499 | linhas de SPED parseadas |
| `cfops` | 238 | tabela de CFOP com carga oficial |
| `profiles` | 3 | usuários |
| `documents`, `events`, `clients` (audit) | **0** | o `audit` está vazio de dado fiscal |

Os XMLs originais estão em dois lugares: a coluna `raw_xml` e o bucket
`xml-uploads` (193 objetos). Os arquivos SPED estão no bucket `sped-files` (2).

### Por que não é `INSERT ... SELECT`

O `audit` guarda **evento**, não linha de tabela. Copiar `xml_documents` para
`documents` daria o número sem a trilha que o defende — e a trilha é o produto.
A migração é **reingestão**: cada XML passa pelas 7 camadas e produz event log
com hash verificável.

### O script

[`scripts/migrar-do-front.ts`](../../scripts/migrar-do-front.ts). **Simula por
padrão**, porque o event log é append-only e evento gravado não sai.

```bash
npx tsx scripts/migrar-do-front.ts --regime <regime>              # simula
npx tsx scripts/migrar-do-front.ts --regime <regime> --executar   # grava
```

A simulação já rodou contra o dado real:

```
193 documento(s) com XML original em xml_documents.
CNPJ do cliente: 04552217000165
  parseiam:  192
  recusados: 1
  entradas:  150   saídas: 42
  competências: 2025-07
  1x camada 1: XML malformado na linha 1
```

**O documento recusado é genuinamente inválido:** a chave
`35250704552217000165550010000094341004838774` tem **35 aberturas de `<ICMS00>`
e 34 fechamentos**. A camada 1 está certa — e o front **aceitou** esse
documento, gravando em `xml_documents` totais de ICMS derivados de um XML
quebrado. É o exemplo concreto do que a migração compra.

### O que a execução exige

A ingestão vai **pela API**, não pelo banco: escrever direto puliria o
orquestrador, o advisory lock por CNPJ e as 7 camadas, produzindo event log sem
as garantias que ele existe para dar. Então:

```bash
MIGRACAO_API_URL=http://localhost:3000 \
MIGRACAO_TOKEN=<access_token de um owner> \
npx tsx scripts/migrar-do-front.ts --regime lucro_presumido --executar
```

O token sai de `POST /v1/auth/login`. O script cria o cliente, abre a
competência 2025-07 e ingere os 192 documentos um a um, relatando camada e
motivo de cada recusa. Ao fim, confira:

```bash
npx tsx src/cli/audit.ts verify --cnpj 04552217000165
```

> **O `--regime` não tem padrão, de propósito.** O regime decide alíquota, anexo
> e a apuração inteira; assumir um faria a migração gravar número errado em
> silêncio. O script recusa rodar sem ele.

### O SPED

Dos dois arquivos no bucket, um é **EFD ICMS/IPI** — que o `audit` não importa,
porque a Onda 12 cobre EFD-Contribuições. O outro é EFD-Contribuições, mas o
front não detectou CNPJ nem período dele. O parser do `audit` lê o registro
`0000` corretamente, então vale tentar por `POST /v1/clients/{cnpj}/sped`.

### Dívida encontrada no caminho

Sete tabelas em produção **sem migração no versionamento** e sem nenhuma
referência no código: `analysis_groups` e `interop_*` (6). Todas com **zero
linhas**. Foram criadas direto no painel do Supabase por alguma sessão que não
commitou a migração. Como estão vazias e órfãs, o certo é derrubá-las — ou, se
houver intenção por trás delas, escrever a migração. Schema em produção que
ninguém consegue recriar é dívida, mesmo quando está vazio.

**Esforço: 2–4h** (a simulação está feita; falta subir a API e executar).

## Passo 3 — Cliente de API, ao lado do cliente Supabase

Não remova o `src/integrations/supabase/client.ts` agora. Ele continua servindo
as features que ficam. O que entra é um segundo cliente, para a API do `audit`.

```bash
cd ~/projects/sped-genius-hub
npm i -D openapi-typescript
npx openapi-typescript ../audit/docs/api/openapi.yaml -o src/integrations/audit/schema.d.ts
```

> **`PROMPT` — cliente da API do audit**
>
> Crie `src/integrations/audit/client.ts`, um cliente HTTP tipado para a API do
> `audit`, usando os tipos de `src/integrations/audit/schema.d.ts`. Ele vai
> conviver com o cliente Supabase existente, não substituí-lo.
>
> 1. Base da URL em `import.meta.env.VITE_AUDIT_API_URL`; todas as rotas com
>    prefixo `/v1`. Nenhuma URL escrita no código.
> 2. O token é o **mesmo** do Supabase Auth que o app já usa: pegue o
>    `access_token` da sessão atual (`supabase.auth.getSession()`) e mande em
>    `Authorization: Bearer <token>`. A API do `audit` verifica esse JWT contra
>    o mesmo projeto Supabase, então não há segundo login.
> 3. `GET /v1/me` devolve `{ user: { id, email, role }, tenant: { id, name, plan } }`.
>    `role` é `owner`, `accountant` ou `viewer`. Use isso, e não a tabela
>    `profiles`, como fonte do papel do usuário.
> 4. Rotas públicas, sem `Authorization`: `/v1/health`, `/v1/plans`,
>    `/v1/price-calculator`, `/v1/simulations/methodology`,
>    `/v1/assistant/capabilities`, `/v1/audit-trails`.
> 5. Contrato de erro, que decide a tela:
>    - `400` → `{ code, message, details }`: erro de campo, inline.
>    - `401` → sessão expirada: use o refresh do Supabase e repita uma vez.
>    - `403` → **mostre a mensagem da API**: ela explica se é papel sem
>      permissão ou recurso fora do plano.
>    - `404` → "não encontrado nesta carteira".
>    - `409` / `422` → `{ rejected, layer, reason, message, details }`. **É
>      inconsistência fiscal, não bug.** Ver o passo 6.
>    - `429` → `{ code, message, usage }`: limite do plano.
> 6. Reaproveite o TanStack Query que o projeto já usa. **Sem retry automático
>    em `POST`**: toda escrita nessa API grava evento no log, e repetir uma
>    escrita em silêncio é o tipo de coisa que o produto existe para impedir.
>
> Não altere nenhuma tela nem nenhum hook existente neste prompt.

### O que já está pronto

O cliente existe: `src/integrations/audit/client.ts` no branch
`feat/cliente-api-audit` do `sped-genius-hub`, com `schema.d.ts` gerado do
contrato (3.130 linhas). Cobre as 14 áreas da API, com `AuditRejection`
carregando `layer` e `reason`, `AuditQuotaError` com o uso, renovação de token
pelo Supabase no `401` e **sem retry em `POST`**.

Verificado: `tsc` limpo no arquivo novo, `npm run build` do front passa, e o
contrato foi exercitado contra o contêiner da API — `/me`, `/clients`,
`/deadlines` e as quatro rotas públicas respondem.

> **Um defeito do backend que apareceu nessa verificação.** `/simulations/methodology`
> e `/assistant/capabilities` estavam **atrás de autenticação**. As duas existem
> para ser lidas *antes* de contratar — a primeira diz o que o simulador não
> modela, a segunda diz o que o assistente sabe responder — e só quem já era
> cliente conseguia lê-las. A autenticação é por hook global (rota nova nasce
> protegida, e `PUBLIC_ROUTES` é o que abre), então o esquecimento é silencioso.
> Corrigido, com teste nos dois sentidos: o que é público responde sem token, e o
> que não é exige token.

`.env` do `sped-genius-hub`:

```bash
VITE_SUPABASE_URL=https://uflputiyytswvagrrzzn.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon key do projeto atual>
VITE_AUDIT_API_URL=https://<api-do-audit>
```

As mesmas três variáveis no painel da Vercel.

**Esforço restante: 1–2h** (era 4–6h; o cliente e os tipos estão feitos, falta
configurar as variáveis na Vercel).

---

## Passo 4 — Migrar feature por feature

Esta é a tabela de decisão. Cada linha é um commit.

> **Revisão desta tabela, feita ao executá-la.** A versão anterior mandava
> migrar `features/xml-import` e `features/sped-upload` por inteiro, e isso
> **perderia capacidade**. Conferido no código: o parser do front cobre
> `efd-icms-ipi` **e** `efd-contribuicoes`, e o cross-reference compara ICMS,
> IPI, PIS e Cofins campo a campo entre XML e SPED. O `audit` cobre só
> EFD-Contribuições, e o dossiê confere só PIS/Cofins. Então o que migra é a
> **ingestão de XML** e o **saldo credor**; o cross-reference e o EFD ICMS/IPI
> ficam, porque não têm equivalente.

| Feature / hook | Arquivos | Destino | Esforço |
|---|---|---|---|
| `hooks/useAuth.tsx`, `hooks/useProfile.tsx` | 2 | **feito** — `GET /v1/me` como fonte de papel e escritório | 0h |
| `hooks/useFileUpload.tsx`, `hooks/useFileList.tsx` | 2 | **feito** — `useDocumentIngestion` + `ClientSelector`, com o 207 | 0h |
| `features/xml-import/hooks/useXmlImport` | 1 | Substituído por `/fiscal/ingestao`. O antigo grava em `xml_documents` sem passar pelas 7 camadas — **aposentar** | 2–3h |
| `features/xml-import/` cross-reference | 8 | **fica** — compara XML × SPED em ICMS, IPI, PIS e Cofins; o `audit` não tem isso | 0h |
| `features/sped-upload/` EFD-Contribuições | — | **feito** — `/fiscal/dossie` importa e monta o dossiê de saldo credor | 0h |
| `features/sped-upload/` EFD ICMS/IPI | 6 | **fica** — o `audit` não parseia esse layout | 0h |
| `features/entity-extraction/` | 8 | **fica como está** — o `audit` não tem equivalente | 0h |
| `features/knowledge-graph/` | 2 | **fica como está** | 0h |
| `features/cfop-manual/` | 2 | **fica como está** por ora; ver a nota abaixo | 0h |
| `pages/AuthTest.tsx` | 1 | **feito** — removida, era página de teste em produção | 0h |

### A sobreposição que sobrou, e a decisão que ela pede

Com a EFD-Contribuições indo para o `audit` e o EFD ICMS/IPI ficando no front,
o mesmo tipo de arquivo passa a ter dois destinos possíveis. Há duas saídas, e a
escolha é de produto, não técnica:

- **Importar a EFD-Contribuições nos dois**: o front para o cross-reference de
  todos os tributos, o `audit` para o dossiê de saldo credor. Custa parsing
  duplicado e ganha as duas saídas.
- **Estender o `audit` para EFD ICMS/IPI** e aposentar o parser do front. É onda
  nova, não migração — e aí o cross-reference também migraria, virando uma
  extensão do dossiê para todos os tributos.

**Decisão tomada: importar nos dois.** O arquivo de EFD-Contribuições sobe no
"Upload SPED" e no "Saldo credor"; as duas conferências ficam disponíveis desde
já, sem trabalho novo. O custo é subir o mesmo arquivo duas vezes.

Para que isso não vire perda silenciosa de conferência, cada tela **explica o que
ela confere e aponta para a outra** (`ConferenciaComplementar`). Sem esse aviso a
pessoa sobe numa das duas, considera o trabalho feito, e perde metade sem saber
que existe.

Dois caminhos ficam abertos, em ordem de custo:

- **Um upload, dois destinos** — uma tela chama as duas rotas. Resolve o
  incômodo de subir duas vezes. **2–4h**, reversível.
- **Estender o `audit` para EFD ICMS/IPI** — o parser lê o outro layout e o
  dossiê confere os quatro tributos; o cross-reference do front vira redundante.
  É o destino certo no longo prazo, mas é onda nova: parser, reconciliação de
  ICMS e IPI, e testes. **20–30h**.

> **Nota sobre CFOP:** o `audit` tem `fiscal_codes` e `cclasstrib_cst` (Onda 5),
> que são as tabelas oficiais usadas pela camada 3 de validação, e elas **nascem
> vazias** de propósito. A `cfops` do `sped-genius-hub` já tem carga oficial. Vale
> abrir uma tarefa separada para alimentar `fiscal_codes` a partir dela — isso
> ligaria a validação de código do `audit`, que hoje reporta `not_verified`.
> Não faz parte desta migração.

### O que ganha de concreto ao migrar `xml-import` e `sped-upload`

Não é refatoração por gosto. O que muda para o usuário:

- **7 camadas de validação** em vez de parse no browser: XML malformado, chave
  inconsistente, documento duplicado e competência fechada passam a ser recusas
  nomeadas, com camada e motivo.
- **Event log append-only**, com hash de projeção verificável por
  `POST /v1/clients/{cnpj}/verify`.
- **Contra-apuração nota a nota** com causa provável, em vez de cross-reference
  genérico — e com os três valores que não se somam (ver passo 6).
- **Dossiê de saldo credor** com a janela de cobertura documental, que distingue
  "crédito sem lastro" de "não coletávamos aquele mês".

### Ordem recomendada

1. `useAuth` + `useProfile` — sem isso nada mais funciona
2. `useFileUpload` + `useFileList` — o caminho de dado mais usado
3. `features/xml-import` — o maior ganho de validação
4. `features/sped-upload` — o mais novo do `audit`, e o menos usado hoje

Depois de cada um: rode o passo 6.

**Esforço restante do passo: 2–3h** (era 26–37h; sobrou aposentar o
`useXmlImport` antigo).

---

## Passo 5 — Telas que o `audit` tem e o front ainda não

Depois da migração, estas ficam faltando. As regras de cada uma estão em
[`TELAS.md`](TELAS.md) — **leia a seção da tela antes de escrever o prompt.**

| Tela | Rotas | Esforço |
|---|---|---|
| ~~2 Carteira de CNPJs~~ | `GET /v1/clients` | **feita** |
| ~~3 Cadastro de empresa~~ | `POST /v1/clients` | **feita** |
| ~~4 Detalhe do cliente~~ | `GET /v1/clients/{cnpj}`, `/periods`, `/events` | **feita** |
| ~~5 Cofre de certificados A1~~ | `/certificate`, `/certificates/expiring` | **feita** |
| ~~7 Saúde do cadastro~~ | `GET /items/health`, `/items`, `PUT .../classification` | **feita** |
| ~~8 Apuração dual~~ | `/assessments/{period}`, `/trace`, `/adjustments`, `/confirm` | **feita** |
| ~~9 Trilhas + Book~~ | `/audit-trails`, `/books/{period}`, `/download` | **feita** |
| ~~10 Contra-apuração e calendário~~ | `/fisco-assessments/{period}`, `/deadlines` | **feita** |
| ~~11 Assistente fiscal~~ | `/assistant/threads`, `/messages`, `/usage`, `/capabilities` | **feita** |
| ~~12 Crédito em risco~~ | `/bank-statements`, `/payment-matches`, `/credits/at-risk` | **feita** |
| 13 Simulador | `/simulations`, `/methodology` | 6–8h |
| 15 Planos e assinatura | `/plans`, `/subscription` | 3–4h |
| 16 Usuários e papéis | `/users`, `/invites` | 2–3h |

**Esforço restante: 11–15h.** A ordem é a da tabela: a carteira primeiro, porque
todas as outras são "dentro de um CNPJ" e precisam dela para navegar.

A carteira rendeu duas correções no backend, que valem como aviso para as telas
seguintes: `GET /v1/clients` documentava `status` como estado da competência e o
implementava como status do CNPJ — filtrar por `open` devolvia `200` com zero
itens, indistinguível de um escritório sem clientes. Agora há `state` (estado da
competência) e `status` (`active`/`inactive`, base da cobrança), valor fora do
enumerado é `400`, e a listagem devolve o `status` para a tela não presumir
ativo.

A tela 4 rendeu outras duas: `has_certificate` vinha de "existe evento
`certificate.stored`" e, como o log é append-only, continuava verdadeiro depois
de remover o certificado — o cabeçalho afirmaria que há um guardado e a coleta
de DF-e falharia sem explicação. E o schema `Client` declarava `current_period`,
que nunca foi implementado. **Ao escrever cada tela, confira a rota contra o
contrato antes de confiar nele** — em cinco telas, sete divergências. A tela 5
achou três de uma vez, todas do mesmo tipo: `usage_count_30d` não filtrava 30
dias, o `total` do log de uso contava a página em vez do total, e o actor do uso
era fixo em `agent` mesmo quando quem agiu foi uma pessoa.

A tela 7 achou mais duas: `warning` somava "classificado com pendência" e "nunca
classificado", que são trabalhos diferentes — e o filtro `health=warning` não
devolvia o item nunca classificado, embora a lista o exibisse com badge de
aviso. Filtrar pelo valor do próprio badge fazia a linha sumir.

A tela 8 achou a maior: o schema `Assessment` do contrato não tinha relação com
a rota — falava em `legacy`/`reform` com `debits_brl` e `carryover_brl`, campos
que nunca existiram, enquanto a rota devolve `totals` em centavos com quatro
números por tributo. E o `GET` não dizia se o `projection_hash` guardado ainda
valia, então a tela mandava ao `confirm` um hash inevitavelmente recusado depois
de qualquer ajuste: `is_current` resolve, e de propósito **sem** expor o hash
atual, que convidaria a tela a reenviá-lo.

A tela 9 achou uma de outra natureza: `white_label` estava documentado como
entitlement de plano e **não era verificado em lugar nenhum** — a tela seria a
única tranca, e qualquer cliente HTTP geraria Book sem a nossa marca num CNPJ de
MEI. Agora é `403` no servidor.

A tela 10 foi a primeira **sem divergência**: os schemas de `FiscoComparison`,
`Divergence`, `ComparisonSummary`, `Deadline` e `Pendency` descrevem exatamente
o que as rotas devolvem. Foram escritos junto da Onda 8, e não antes dela — que
é o que explica a diferença para os schemas das Ondas 2 e 6.

A tela 11 também não achou divergência — o assistente já distinguia `403` de
`429` e já devolvia `X-Assistant-Remaining`. Mas ela acrescentou uma trava que
não existia: o executor de `suggested[]` recusa endpoint fora de
`/clients/{cnpj}/`. A sugestão vem da nossa própria API, e ainda assim uma tela
que dispara qualquer endereço que a resposta mandar confia em dado remoto para
escolher o que escrever no event log.

A tela 12 encontrou uma lacuna, e não uma divergência: `credit.lost` está no
vocabulário e no projetor, e **nenhuma rota o emite**. A tela não oferece o
botão, porque não há para onde mandar — e `TELAS.md` diz que declarar crédito
perdido é decisão do contador, não cálculo. Se a decisão for registrá-la no
sistema, falta `POST /clients/{cnpj}/credits/{access_key}/lost` com
justificativa obrigatória; é onda nova, não ajuste de tela.

---

## Passo 6 — As cinco regras que não podem ser perdidas na renderização

O passo mais importante do plano. O backend distingue **"verifiquei e está
certo"** de **"não verifiquei"**, e isso aparece em quatro módulos. Se a tela
colapsar os dois estados no mesmo visual, o trabalho de backend se perde na
renderização — e o painel passa a afirmar ao contador coisas que o sistema nunca
verificou.

### 1. "Não conferido" nunca tem a cara de "aprovado"

| Campo | Onde | Significa |
|---|---|---|
| `not_verified` | Saúde do cadastro | A tabela oficial de códigos não estava carregada |
| `not_applicable` | Trilhas de auditoria | A trilha não pôde ser executada |
| `nao_verificavel` | Dossiê de saldo credor | Competência fora da janela de cobertura |
| `winner: null` | Simulador | A escolha depende de alíquota não publicada |

Nos quatro: **cor de aviso e o texto "não verificado"**. Nunca verde, nunca
junto dos aprovados, nunca um vazio silencioso.

### 2. Valor ausente não é zero

`dueCents: null` na apuração, `credit_at_risk_brl: null` na carteira,
`releasedCents: 0` no crédito em risco. Renderize *"não determinável"* com o
motivo ao lado. Um `0` é **afirmação fiscal**; um `—` sem explicação faz o
contador achar que é bug.

### 3. Números que não se somam

- **Contra-apuração:** `exposureCents` (será cobrado), `creditLossCents`
  (dinheiro na mesa), `creditAtRiskCents` (tende a ser glosado). Um milhão de
  cada lado se cancelaria num "líquido".
- **Simulador:** `directTaxMonthlyCents` (a guia) e `economicCostMonthlyCents`
  (guia + desconto que o cliente PJ exige). No Simples integrado a guia é a
  **menor** e o custo econômico pode ser o **maior**.
- **Dossiê:** `unbackedCents` (o que o pente-fino cobra) e `unverifiableCents`
  (o que não foi conferido). Somá-los acusaria o cliente por limitação nossa.

### 4. Causa provável é hipótese, não diagnóstico

`probableCause` na contra-apuração, `reason` no crédito em risco. Rotule como
*"causa provável"*. O sistema compara duas listas de números; a razão real pode
ser erro nosso, erro do Fisco, documento cancelado ou nota ainda não processada.

### 5. O assistente sugere; o usuário executa

`suggested[]` traz `method`, `endpoint`, `payload` e `rationale`. Botão **com
confirmação** e o `rationale` visível. Toda afirmação de `kind: 'fact'` traz
`citations[]` — **afirmação factual sem chip de citação visível é bug de tela**,
porque a API nunca emite uma.

> **`PROMPT` — auditoria das cinco regras**
>
> Revise as telas alteradas contra estas cinco regras: *[cole a seção acima]*.
> Para cada violação, corrija e me diga o que mudou. Não altere chamadas de API.

Rode ao fim de **cada feature migrada**, não no fim do projeto. **2h por
rodada.**

---

## Passo 7 — Verificação

```bash
cd ~/projects/sped-genius-hub

# 1. Design system respeitado
grep -rnE '(bg|text|border)-\[#|dark:|rounded-(xl|2xl|3xl)|shadow-(xl|2xl)' src/

# 2. Nenhuma URL escrita no codigo
grep -rnE "https?://(localhost|[a-z0-9-]+\.supabase\.co|[a-z0-9-]+\.vercel\.app)" src/ --include=*.ts --include=*.tsx

# 3. Nenhum dado fiscal saindo do Supabase direto
#    (deve sobrar SO as features que ficam: entity-extraction, knowledge-graph, cfop-manual)
grep -rln "supabase" src/ | grep -vE "integrations/supabase|features/(entity-extraction|knowledge-graph|cfop-manual)|hooks/useAuth"

# 4. Build e tipos
npm run build
```

O item 3 é o que prova a migração: se sobrar qualquer arquivo de `xml-import`,
`sped-upload` ou de upload de arquivo nessa lista, há caminho de escrita fiscal
fora do orquestrador.

**Roteiro funcional, com um CNPJ de teste:** login → cadastrar empresa → abrir
competência → subir XML → saúde do cadastro → apurar → subir proposta do Fisco →
gerar Book → baixar o PDF e conferir o hash do rodapé contra
`POST /v1/clients/{cnpj}/verify`.

Esse último passo é o laço de governança fechando: o número impresso no
documento que o escritório entrega ao cliente é reproduzível pelo replay do
event log.

**Esforço: 4–6h.**

---

## Carga horária

| Passo | Entrega | Esforço |
|---|---|---|
| **1** | Deploy da API — `Dockerfile` e CI **feitos**; falta escolher provedor e subir | **2–4h** |
| **2** | Migrar o dado fiscal — simulação **feita**; falta executar | **2–4h** |

| **3** | Cliente de API — **feito**; falta configurar a Vercel | **1–2h** |
| **4** | Migrar as features acopladas — quase tudo **feito** | **2–3h** |
| **5** | As 13 telas que faltam | **55–77h** |
| **6** | Auditoria das cinco regras — 2h × 6 rodadas | **12h** |
| **7** | Verificação e roteiro funcional | **4–6h** |
| | **Total** | **~78–110h** |

Para uma pessoa em tempo integral: **3 a 4 semanas**. Em meio período, dobre.

**Como os números foram formados, para você poder corrigi-los:** o Lovable gera
a tela em minutos, e o custo real é revisar, corrigir e reprompt — assumi **20%
gerando, 80% ajustando**. É por isso que telas com muita regra de negócio
(apuração, contra-apuração, dossiê) custam o dobro de telas de cadastro, mesmo
tendo menos campos. Cada tela dos blocos densos tem 8 a 12 regras em
[`TELAS.md`](TELAS.md), e cada regra é um ponto onde o Lovable acerta ou erra.

**Observação sobre o total:** ele ficou praticamente igual ao de construir do
zero. O front existente economiza o Bloco 1 inteiro (login, shell, upload,
~18h), e a migração das 4 features acopladas custa ~30h que não existiriam num
projeto novo. O ganho real não é tempo — é **não jogar fora um app em produção**
e manter as três features que o `audit` não tem.

**O que não está na conta:** QA com dado real de cliente, acessibilidade além do
que o shadcn entrega, responsivo de celular (o painel é de trabalho em desktop),
i18n, e os testes automatizados que o `sped-genius-hub` não tem.
