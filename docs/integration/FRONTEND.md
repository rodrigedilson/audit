# Integração com Frontend (Lovable)

## Visão Geral

O frontend deste projeto é desenvolvido externamente utilizando o **Lovable** (lovable.dev) e unificado via GitHub. Este documento define os contratos e convenções para integração.

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│                   GitHub                         │
│                                                  │
│  ┌──────────────┐       ┌──────────────────────┐│
│  │   audit       │       │  sped-genius-hub     ││
│  │  (backend)    │◄─────►│   (Lovable app)      ││
│  │  Este repo    │  API  │   Repo separado      ││
│  └──────────────┘       └──────────────────────┘│
│         │                         │              │
│    Node / Fastify           React / Vite         │
│    Event sourcing           Lovable.dev          │
│    Postgres (Supabase)      shadcn/ui            │
└─────────────────────────────────────────────────┘
```

## Design System EJR

Este produto faz parte da **EJR Software** (www.ejrsoftware.com.br) e segue o
**EJR Design System 2.0**. A fonte da verdade fica neste repositório (backend),
e o frontend consome o padrão — nunca o contrário.

```
design-system/
├── design-system.html      # Referência visual navegável (abrir no browser)
├── tokens.json             # Tokens brutos
├── tokens.css              # Tokens em CSS puro (--ejr-*)
└── lovable/                # Pacote pronto para o app Lovable
    ├── index.css           # → src/index.css do sped-genius-hub
    └── tailwind.config.ts  # → tailwind.config.ts do sped-genius-hub
```

### Princípios inegociáveis

| Regra | Detalhe |
|-------|---------|
| **Light-only** | Dark mode como padrão é proibido. A classe `.dark` espelha o tema claro. |
| **Verde institucional** | `#365D5A` reservado para CTA, links, foco e identidade. |
| **Neutros quentes** | Canvas `#F8F7F6`, superfícies brancas, hover `#EFEDEB`. |
| **Controles compactos** | Alturas 32 / 36 / 40px, raio 6px, fonte 14/500. |
| **Hierarquia editorial** | Montserrat em títulos, Inter no corpo, JetBrains Mono em código. |
| **Sem peso visual** | Sem glow, gradientes pesados ou sombras fortes. |

### Aplicação no frontend

Os dois arquivos em `design-system/lovable/` substituem integralmente os
equivalentes do template padrão do Lovable. Eles preservam o contrato de nomes
do shadcn/ui (`--primary`, `--muted`, `--sidebar-*`), de modo que **todos os
componentes shadcn já existentes assumem a identidade EJR sem alteração de
código**.

Tokens adicionais expostos ao Tailwind:

- Escala do verde: `primary-50` … `primary-900`, `primary-hover`, `primary-active`
- Feedback: `success`, `warning`, `info` (cada um com variante `-subtle`)
- Raios: `rounded-card` (12px), `rounded-panel` (16px), `rounded-pill`
- Sombras: `shadow-xs` … `shadow-lg`

### Prompt para o Lovable

Ao aplicar o padrão via lovable.dev, usar:

> Substitua integralmente `src/index.css` e `tailwind.config.ts` pelo conteúdo
> que vou colar a seguir (EJR Design System 2.0). Depois, faça uma varredura em
> todos os componentes e páginas e remova qualquer cor, fonte, raio ou sombra
> escritos diretamente no código (`bg-[#...]`, `text-white`, `rounded-xl`,
> `shadow-2xl`, classes `dark:`), trocando pelos tokens semânticos
> (`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`,
> `border-border`, `bg-primary`, `rounded-card`, `shadow-sm`). Não introduza
> dark mode. Títulos usam `font-heading`; corpo usa a fonte padrão. Botões têm
> altura 36px e raio 6px. Não altere nenhuma lógica de negócio, rota, chamada
> de API ou estado.

### Verificação

Antes de considerar a adaptação concluída, conferir no `sped-genius-hub`:

```bash
# Nao deve retornar nada: cores/raios/sombras fora do padrao
grep -rnE '(bg|text|border)-\[#|dark:|rounded-(xl|2xl|3xl)|shadow-(xl|2xl)' src/
```

## Convenções de Integração

### Branches
- `main` — produção estável
- `feature/*` — uma branch por entrega, com PR para `main`

### API Contract
O backend expõe APIs REST que o frontend consome. O contrato é definido via OpenAPI.

```
Localização: docs/api/openapi.yaml   (OAS 3.0.3, v1.0.0)
```

Gere os tipos a partir dele em vez de escrevê-los à mão:

```bash
npx openapi-typescript ../audit/docs/api/openapi.yaml -o src/api/schema.d.ts
```

### Variáveis de Ambiente

No **frontend**, três (as mesmas no arquivo local e na Vercel):

```bash
VITE_AUDIT_API_URL=http://localhost:3000        # prod: URL do serviço no Render
VITE_SUPABASE_URL=https://uflputiyytswvagrrzzn.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon key do projeto>
```

O front usa o Supabase só para login e para as funcionalidades que não têm
equivalente no backend (ver [`LOVABLE.md`](LOVABLE.md)). O token vem de
`supabase.auth.getSession()` e vai no `Authorization` de cada chamada à API. Os
dados fiscais só saem por rota autenticada da API.

No **backend**:

```bash
CORS_ORIGINS=https://sped-genius-hub.vercel.app,http://localhost:5173
```

### CORS

`CORS_ORIGINS` é uma lista de **origens exatas** e não aceita curinga. Sem a
variável, o padrão é apenas `http://localhost:5173` — liberar `*` por omissão
transformaria um esquecimento de configuração em CORS aberto num produto que
custodia certificado digital de terceiros.

Então a origem da Vercel entra literal. Preview deploy da Vercel gera uma URL
nova por commit, e cada uma seria outra origem — para testar preview, use o
frontend local apontado para a API deployada.

## Fluxo de Trabalho

### 1. Desenvolvimento Local
```bash
# Backend (este repo)
npm run build
node dist/cli/audit.js serve     # http://localhost:3000
npm run doctor                   # confere o ambiente antes de subir

# Frontend (repo Lovable)
cd ../sped-genius-hub && npm run dev   # http://localhost:5173
```

O plano de migração do frontend está em [`LOVABLE.md`](LOVABLE.md). O
`sped-genius-hub` já existe e está em produção; o trabalho é trocar a fonte do
dado fiscal, não construir telas do zero.

### 2. Integração Contínua
- Backend: push para `main` → deploy no Render, com os segredos sincronizados do
  Doppler `prd` (ver [`SEGREDOS.md`](../setup/SEGREDOS.md#passo-a-passo))
- Frontend: Lovable publica no repo `sped-genius-hub` → deploy nativo da Vercel
  em <https://sped-genius-hub.vercel.app>

### 3. Testes de Integração

Os testes de API do backend cobrem o contrato do lado dele:

```bash
TEST_DATABASE_URL=postgresql://... npm test
```

O contrato em si é validado à parte:

```bash
npx @redocly/cli lint docs/api/openapi.yaml
```

## Estrutura de Dados Compartilhada

Os schemas ficam **dentro** do `openapi.yaml`, em `components/schemas`, e não em
arquivos soltos: o contrato precisa validar como uma peça só, e um DTO fora dele
é um DTO que ninguém garante.

## Sincronização com Lovable

O Lovable faz push automático para o repositório GitHub. Para sincronizar:

1. O repo do Lovable é `rodrigedilson/sped-genius-hub`
2. Este repo (backend) é `rodrigedilson/audit`
3. Ambos compartilham o mesmo padrão de branches
4. Contratos de API são versionados neste repo em `docs/api/`
