# Passo a passo — construir o `audit-frontend` no Lovable

Este documento é o roteiro de execução. Os blocos marcados **`PROMPT`** são para
colar no Lovable, um por vez — o Lovable acerta muito mais em pedidos pequenos e
incrementais do que num pedido gigante.

Duas fontes da verdade, que o frontend consome e **não** reescreve:

| O quê | Onde |
|---|---|
| Contrato da API | [`docs/api/openapi.yaml`](../api/openapi.yaml) — v1.0.0, 60+ rotas |
| Especificação das telas | [`TELAS.md`](TELAS.md) — 16 telas, com as regras de cada uma |
| Design system | [`design-system/lovable/`](../../design-system/lovable/) |

---

## Carga horária

| Passo | Entrega | Esforço |
|---|---|---|
| **0** | Acesso à API — caminho A (local) | **1h** |
| **0** | Acesso à API — caminho B (túnel) | **+1h** |
| **0** | Acesso à API — caminho C (deploy) | **8–12h** |
| **1** | Design system aplicado | **1–2h** |
| **2** | Cliente de API tipado, auth e contrato de erro | **4–6h** |
| **4** | Componentes base 1 a 8 | **10–14h** |
| **3** | Bloco 1 — Fundação (5 telas) | **12–18h** |
| **3** | Bloco 2 — O mês (3 telas) | **16–22h** |
| **3** | Bloco 3 — O entregável (2 telas) | **12–18h** |
| **3** | Bloco 4 — Diferenciais (4 telas) | **18–26h** |
| **3** | Bloco 5 — Comercial (4 telas) | **14–20h** |
| **4** | Componentes 9 a 14, junto dos blocos | **8–12h** |
| **5** | Auditoria das cinco regras — 2h por bloco | **10h** |
| **6** | Verificação e roteiro funcional | **4–6h** |
| | **Total sem deploy** | **~110–155h** |
| | **Total com deploy (caminho C)** | **~120–170h** |

Para uma pessoa em tempo integral: **3 a 4 semanas** sem o deploy, **4 a 5** com.
Em meio período, dobre.

**Como estes números foram formados, para você poder corrigi-los:**

- O Lovable gera a tela em minutos; o custo real é **revisar, corrigir e
  reprompt**. A divisão típica que assumi é **20% gerando, 80% ajustando** — e é
  por isso que telas com muita regra de negócio (apuração, contra-apuração,
  dossiê) custam o dobro de telas de cadastro, mesmo tendo menos campos.
- Cada tela dos blocos 2 a 4 tem entre 8 e 12 regras em [`TELAS.md`](TELAS.md), e
  cada regra é um ponto onde o Lovable acerta ou erra. A faixa alta da estimativa
  é o cenário em que metade precisa de um segundo prompt.
- O passo 5 (auditoria das cinco regras) está contado **à parte de propósito**.
  É a etapa que as equipes cortam quando o prazo aperta, e é justamente a que
  preserva o valor do backend — sem ela, o painel afirma ao contador coisas que
  o sistema nunca verificou.
- Os componentes do passo 4 aparecem em duas linhas porque os 8 primeiros são
  pré-requisito do bloco 2, e os outros 6 nascem junto da tela que os usa.

**O que não está nesta conta:** QA com dados reais de um cliente, acessibilidade
além do que o shadcn já entrega, responsivo para celular (o painel é de trabalho
em desktop), internacionalização e o `audit-frontend` em produção com domínio e
certificado.

---

## Passo 0 — Resolver o acesso à API antes de abrir o Lovable

**Este é o único bloqueio real, e ele existe hoje:** o repositório do backend não
tem configuração de deploy. Há CI (`.github/workflows/ci.yml`), mas nenhum
`Dockerfile`, `fly.toml` ou equivalente. O preview do Lovable roda numa página
`https://*.lovable.app`, e ela precisa alcançar a API de algum lugar.

Três caminhos, em ordem de esforço:

### A. Desenvolver localmente (mais rápido para começar)

O Lovable faz push para o GitHub. Você clona o `audit-frontend`, roda
`npm run dev` e aponta para o backend local:

```bash
# terminal 1 — backend
cd ~/projects/audit
npm run build
node dist/cli/audit.js serve         # sobe em http://localhost:3000

# terminal 2 — frontend
cd ~/projects/audit-frontend
npm run dev                          # http://localhost:5173
```

`CORS_ORIGINS` já aceita `http://localhost:5173` por omissão — é o padrão
quando a variável não está definida. Nada a configurar.

**Limite:** o preview dentro do editor do Lovable não vai funcionar, porque a
página servida de `lovable.app` não alcança o seu `localhost`. Você constrói no
Lovable e confere rodando local.

### B. Túnel para o backend local (preview do Lovable funcionando)

```bash
# no repo do backend, com o serve rodando
npx localtunnel --port 3000          # ou cloudflared tunnel --url http://localhost:3000
```

Pegue a URL `https://...` que o túnel devolve e:

```bash
# no .env do backend
CORS_ORIGINS=http://localhost:5173,https://<seu-projeto>.lovable.app
```

`CORS_ORIGINS` **não aceita curinga** — a lista é de origens exatas, de propósito
(ver o comentário em [`env.ts`](../../src/config/env.ts)): liberar `*` por
omissão transformaria um esquecimento de configuração em CORS aberto num produto
que custodia certificado digital de terceiros. Então a origem do seu projeto
Lovable entra explícita.

### C. Deploy do backend (o caminho definitivo)

É o que precisa existir antes de qualquer cliente real. Não está pronto, e é
trabalho separado deste roteiro. O mínimo:

- `Dockerfile` (Node 20+, `npm ci && npm run build`, `CMD node dist/cli/audit.js serve`)
- variáveis: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_JWT_SECRET` (ou `SUPABASE_JWKS_URL`), `CERTIFICATE_MASTER_KEY`,
  `CORS_ORIGINS`, `API_PORT`
- `CERTIFICATE_MASTER_KEY` **em secret manager**, nunca em variável de ambiente
  do painel. Rotacioná-la torna ilegível todo certificado A1 já armazenado.

> **Recomendação:** comece pelo caminho A, que não depende de nada. Passe ao C
> quando a primeira tela estiver de pé.

---

## Passo 1 — Criar o projeto e aplicar o design system

Crie o projeto no lovable.dev e conecte ao repositório `rodrigedilson/audit-frontend`.

Depois cole o conteúdo de `design-system/lovable/index.css` e
`design-system/lovable/tailwind.config.ts` com o prompt que já está em
[`FRONTEND.md`](FRONTEND.md#prompt-para-o-lovable).

**Verificação** — no `audit-frontend`, isto não deve retornar nada:

```bash
grep -rnE '(bg|text|border)-\[#|dark:|rounded-(xl|2xl|3xl)|shadow-(xl|2xl)' src/
```

---

## Passo 2 — Camada de API, antes de qualquer tela

Gerar os tipos do contrato evita metade dos erros de integração:

```bash
cd ~/projects/audit-frontend
npm i -D openapi-typescript
npx openapi-typescript ../audit/docs/api/openapi.yaml -o src/api/schema.d.ts
```

> **`PROMPT` — cliente de API**
>
> Crie `src/api/client.ts` com um cliente HTTP tipado para a nossa API REST,
> usando os tipos de `src/api/schema.d.ts`.
>
> Regras:
>
> 1. A base da URL vem de `import.meta.env.VITE_API_URL`, e todas as rotas têm
>    prefixo `/v1`. Não use nenhum valor de URL escrito no código.
> 2. **Não instale nem use `supabase-js`.** A autenticação é feita pela nossa
>    API: `POST /v1/auth/login` com `{ email, password }` devolve
>    `{ access_token, expires_in, tenant: { id, name, plan } }`. Guarde o token
>    em memória e em `sessionStorage`, e mande `Authorization: Bearer <token>`
>    em toda requisição. O frontend nunca fala com o Supabase direto.
> 3. `GET /v1/me` devolve `{ user: { id, email, role }, tenant: { id, name, plan } }`.
>    `role` é `owner`, `accountant` ou `viewer`.
> 4. Rotas públicas, que **não** devem levar `Authorization`: `/v1/auth/login`,
>    `/v1/health`, `/v1/plans`, `/v1/price-calculator`.
> 5. Tratamento de erro — o corpo de erro tem forma conhecida e o `status`
>    decide a tela:
>    - `400` → `{ code, message, details }`: erro de campo, destaque inline.
>    - `401` → sessão expirada: limpe o token e vá para o login.
>    - `403` → `{ code, message }`: **mostre a mensagem da API**. Ela explica se
>      é papel sem permissão ou recurso fora do plano.
>    - `404` → `{ code, message }`: "não encontrado nesta carteira".
>    - `409` / `422` → `{ rejected, layer, reason, message, details }`. **É
>      inconsistência fiscal, não bug.** Exponha camada + motivo + mensagem; ver
>      o passo 5 deste roteiro.
>    - `429` → `{ code, message, usage }`: limite do plano atingido.
> 6. Use TanStack Query para cache e revalidação. Não invente retry automático
>    em `POST`: toda escrita nesta API gera evento no log, e repetir uma escrita
>    silenciosamente é o tipo de coisa que este produto existe para impedir.
>
> Não crie nenhuma tela ainda.

`.env` do `audit-frontend`:

```bash
VITE_API_URL=http://localhost:3000   # ou a URL do túnel / do deploy
```

---

## Passo 3 — Ordem de construção das telas

Cinco blocos. Cada um entrega algo demonstrável, e cada um depende só do
anterior. A numeração das telas é a de [`TELAS.md`](TELAS.md), que traz as regras
detalhadas de cada uma — **leia a seção da tela antes de escrever o prompt dela.**

| Bloco | Telas | Esforço | Por que nesta ordem |
|---|---|---|---|
| **1 — Fundação** | 1 Login · AppShell · 2 Carteira · 3 Cadastro de empresa · 4 Detalhe do cliente | 12–18h | Sem a casca e a carteira não há onde pendurar nada |
| **2 — O mês** | 6 Ingestão · 7 Saúde do cadastro · 8 Apuração dual | 16–22h | É o ciclo de trabalho; a saúde do cadastro é o diferencial #1 |
| **3 — O entregável** | 9 Trilhas + Book · 10 Contra-apuração + calendário | 12–18h | O primeiro artefato que sai para o cliente final |
| **4 — Diferenciais** | 5 Cofre A1 · 11 Assistente · 12 Crédito em risco · 14 Dossiê | 18–26h | Cada um é um upsell independente |
| **5 — Comercial** | Calculadora pública · 13 Simulador · 15 Planos · 16 Usuários | 14–20h | Funil de aquisição; **pode ser feito em paralelo**, porque as duas primeiras são páginas públicas e não dependem da casca autenticada |

Esforço por tela dentro de cada bloco, para você poder cortar ou adiar uma sem
desmontar a conta:

| Tela | Esforço | O que pesa |
|---|---|---|
| 1 Login | 2–3h | Contrato de erro e guarda de sessão |
| AppShell | 4–6h | Sidebar, papéis e tratamento de `403` |
| 2 Carteira | 4–6h | DataTable com filtros, paginação e estado vazio |
| 3 Cadastro de empresa | 2–3h | Formulário e validação de CNPJ |
| 4 Detalhe do cliente | 3–4h | Tabs e KPIs |
| 5 Cofre A1 | 3–4h | Upload, aviso de vencimento, PFX que nunca volta |
| 6 Ingestão | 4–6h | `207 Multi-Status`: aceitos e rejeitados na mesma tela |
| 7 Saúde do cadastro | 5–7h | Propagação por item e o estado `not_verified` |
| 8 Apuração dual | 7–10h | Quatro números distintos, `null` ≠ zero, memória de cálculo |
| 9 Trilhas + Book | 6–9h | Quatro estados de trilha e o download com hash |
| 10 Contra-apuração + calendário | 6–9h | Três valores que não se somam, duas listas separadas |
| 11 Assistente | 6–8h | Citações clicáveis e `suggested[]` com confirmação |
| 12 Crédito em risco | 5–7h | Cinco estados e o resolvedor de ambiguidade |
| 13 Simulador | 6–8h | Heatmap de sensibilidade e `winner: null` |
| 14 Dossiê | 4–6h | `nao_verificavel` e a janela de cobertura |
| Calculadora pública | 3–4h | Página pública, sem sessão |
| 15 Planos | 3–4h | Cancelamento em um clique, sem retenção |
| 16 Usuários | 2–3h | Convites e papéis |

### Bloco 1 — o prompt de partida

> **`PROMPT` — casca e login**
>
> Crie o AppShell do painel e a tela de login.
>
> **Login:** e-mail e senha, chamando `POST /v1/auth/login`. Mensagem de erro
> genérica em falha — a API devolve "E-mail ou senha inválidos" de propósito, e
> distinguir "e-mail não existe" de "senha errada" entregaria uma lista de
> usuários a quem sonda a API. Guarde o token e o `tenant` do retorno; o nome do
> escritório já vem no login, então o painel não deve piscar sem carteira.
>
> **AppShell:** sidebar fixa com a navegação, cabeçalho com o nome do escritório
> e o menu do usuário. Use os tokens `--sidebar-*` do design system. Itens da
> sidebar, nesta ordem: Carteira, Competências, Cofre de certificados, Prazos,
> Assistente, Planos, Usuários, Configurações.
>
> **Papéis:** `GET /v1/me` devolve `role`. `viewer` é somente leitura. Esconda o
> que o papel não permite **e** trate o `403` — esconder botão não é
> autorização, é conveniência de tela.
>
> Não crie as telas internas ainda; deixe rotas com placeholder.

Depois, uma tela por prompt, sempre na forma:

> **`PROMPT` — tela N**
>
> Crie a tela *[nome]*, consumindo *[rotas]*. As regras estão abaixo, e elas não
> são sugestão — cada uma existe porque o contrário induz o contador ao erro:
>
> *[cole aqui a seção correspondente de `TELAS.md`, os bullets inteiros]*

---

## Passo 4 — Os 14 componentes que faltam no design system

`design-system/` tem os tokens e os primitivos, mas nasceu de outro produto
(ReviewCard, StepPanel, Citation, de um assistente de requisitos regulatórios).
Para este painel faltam, em ordem de necessidade — a lista completa com o
porquê está no fim de [`TELAS.md`](TELAS.md#componentes-que-faltam-no-design-system):

1. **AppShell** com sidebar montada
2. **DataTable** com ordenação, paginação, estado vazio e de carregamento
3. **Barra de filtros** (select + busca + limpar)
4. **Stat tile / KPI**
5. **Tabs** para o detalhe do cliente
6. **Modal / Sheet** para cadastro e upload
7. **Timeline de eventos** (aproveita `.ejr-citation`)
8. **Badges de estado fiscal** (competência e crédito)
9. **Badge de trilha em quatro estados** — `passed`, `warning`, `failed` e
   `not_applicable`
10. **Fila de pendências**, distinta do calendário: ordenada por gravidade e com
    `daysOpen`, nunca com vencimento inventado
11. **Chip de citação** clicável, que abre o evento ou documento citado
12. **Resolvedor de ambiguidade**: candidatos lado a lado para o humano escolher
13. **Heatmap de sensibilidade** (alíquota × fração de crédito)
14. **Badge de "não conferido"** — ver o passo 5, é o mais importante da lista

> **`PROMPT` — componentes base**
>
> Antes das telas do bloco 2, crie em `src/components/` os componentes 1 a 8 da
> lista acima, usando shadcn/ui como base e apenas tokens semânticos do design
> system. DataTable com estado vazio e de carregamento explícitos — lista vazia
> sem mensagem é indistinguível de falha de carregamento.

---

## Passo 5 — As cinco regras que não podem ser perdidas na renderização

Este é o passo mais importante do roteiro. O backend foi construído para
distinguir **"verifiquei e está certo"** de **"não verifiquei"**, e essa
distinção aparece em quatro módulos diferentes. Se a tela colapsar os dois
estados no mesmo visual, todo o trabalho de backend se perde na renderização — e
o produto passa a afirmar ao contador coisas que o sistema nunca verificou.

### 1. "Não conferido" nunca tem a cara de "aprovado"

O mesmo conceito, em quatro lugares:

| Campo | Onde | Significa |
|---|---|---|
| `not_verified` | Saúde do cadastro | A tabela oficial de códigos não estava carregada |
| `not_applicable` | Trilhas de auditoria | A trilha não pôde ser executada |
| `nao_verificavel` | Dossiê de saldo credor | A competência está fora da janela de cobertura |
| `winner: null` | Simulador | A escolha depende de uma alíquota não publicada |

Nos quatro, **cor de aviso e o texto "não verificado"** — nunca verde, nunca
junto dos aprovados, nunca um vazio silencioso.

### 2. Valor ausente não é zero

`dueCents: null` na apuração, `credit_at_risk_brl: null` na carteira,
`releasedCents: 0` no crédito em risco. Renderize *"não determinável"* com o
motivo ao lado. Um `0` é uma **afirmação fiscal**; um `—` sem explicação faz o
contador achar que é bug.

### 3. Números que não se somam

Três casos em que um "total líquido" esconderia o problema:

- **Contra-apuração:** `exposureCents` (será cobrado), `creditLossCents`
  (dinheiro na mesa) e `creditAtRiskCents` (tende a ser glosado). Um milhão de
  cada lado se cancelaria na tela.
- **Simulador:** `directTaxMonthlyCents` (a guia) e `economicCostMonthlyCents`
  (guia + desconto que o cliente PJ exige). No Simples integrado a guia é a
  **menor** e o custo econômico pode ser o **maior**.
- **Dossiê:** `unbackedCents` (o que o pente-fino cobra) e `unverifiableCents`
  (o que não foi conferido). Somá-los acusaria o cliente por limitação nossa.

### 4. Causa provável é hipótese, não diagnóstico

`probableCause` na contra-apuração e `reason` no crédito em risco. Rotule como
*"causa provável"*. O sistema compara duas listas de números; a razão real pode
ser erro nosso, erro do Fisco, documento cancelado ou nota ainda não processada.

### 5. O assistente sugere; o usuário executa

`suggested[]` vem com `method`, `endpoint`, `payload` e `rationale`. Renderize
como botão **com confirmação** e o `rationale` visível. Toda afirmação de
`kind: 'fact'` traz `citations[]` — **uma afirmação factual sem chip de citação
visível é bug de tela**, porque a API nunca emite uma.

> **`PROMPT` — auditoria das cinco regras**
>
> Revise todas as telas já construídas contra estas cinco regras: *[cole a
> seção acima]*. Para cada violação encontrada, corrija e me diga o que mudou.
> Não altere nenhuma chamada de API.

Rode este prompt ao fim de **cada bloco**, não só no fim do projeto.

---

## Passo 6 — Verificação antes de considerar pronto

```bash
cd ~/projects/audit-frontend

# 1. Design system respeitado
grep -rnE '(bg|text|border)-\[#|dark:|rounded-(xl|2xl|3xl)|shadow-(xl|2xl)' src/

# 2. Nenhuma URL de API escrita no código
grep -rnE "https?://(localhost|[a-z0-9.-]+\.supabase\.co)" src/ --include=*.ts --include=*.tsx

# 3. O frontend não fala com o Supabase direto
grep -rn "supabase" src/ package.json

# 4. Build e tipos
npm run build
```

Os quatro devem passar limpos: 1 e 2 sem saída, 3 sem nenhuma ocorrência, 4 sem
erro.

**Roteiro funcional, com um CNPJ de teste:** login → cadastrar empresa → abrir
competência → subir XML → ver saúde do cadastro → apurar → subir proposta do
Fisco → gerar Book → baixar o PDF e conferir o hash do rodapé contra
`POST /v1/clients/{cnpj}/verify`.

Esse último passo é o laço de governança fechando: o número impresso no
documento que o escritório entrega ao cliente é reproduzível pelo replay do
event log.
