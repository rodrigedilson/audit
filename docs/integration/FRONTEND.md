# Integração com Frontend (Lovable)

## Visão Geral

O frontend deste projeto é desenvolvido externamente utilizando o **Lovable** (lovable.dev) e unificado via GitHub. Este documento define os contratos e convenções para integração.

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│                   GitHub                         │
│                                                  │
│  ┌──────────────┐       ┌──────────────────────┐│
│  │   audit       │       │   audit-frontend     ││
│  │  (backend)    │◄─────►│   (Lovable app)      ││
│  │  Este repo    │  API  │   Repo separado      ││
│  └──────────────┘       └──────────────────────┘│
│         │                         │              │
│    Python/Node              React/Vite           │
│    Claude Flow              Lovable.dev          │
│    Hive Mind                UI Components        │
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
    ├── index.css           # → src/index.css do audit-frontend
    └── tailwind.config.ts  # → tailwind.config.ts do audit-frontend
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

Antes de considerar a adaptação concluída, conferir no `audit-frontend`:

```bash
# Nao deve retornar nada: cores/raios/sombras fora do padrao
grep -rnE '(bg|text|border)-\[#|dark:|rounded-(xl|2xl|3xl)|shadow-(xl|2xl)' src/
```

## Convenções de Integração

### Branches
- `main` - Produção estável
- `develop` - Desenvolvimento ativo
- `feature/*` - Features individuais
- `hotfix/*` - Correções urgentes

### API Contract
O backend expõe APIs REST que o frontend consome. O contrato é definido via OpenAPI.

```
Localização: docs/api/openapi.yaml
```

### Variáveis de Ambiente
```bash
# .env.example
API_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,https://app.lovable.dev
```

### CORS
O backend deve permitir origens do Lovable durante desenvolvimento:
- `http://localhost:5173` (dev local)
- `https://*.lovable.app` (preview do Lovable)
- Domínio de produção (configurável)

## Fluxo de Trabalho

### 1. Desenvolvimento Local
```bash
# Backend (este repo)
source .venv/bin/activate
npm run dev       # ou python src/main.py

# Frontend (repo Lovable) - desenvolvido via lovable.dev
# Acessar: https://lovable.dev/projects/<project-id>
```

### 2. Integração Contínua
- Backend: push para `main` → deploy automático
- Frontend: Lovable publica no repo `audit-frontend` → deploy via GitHub Actions

### 3. Testes de Integração
```bash
# Rodar testes E2E que validam contrato frontend-backend
pytest tests/integration/ -v
```

## Estrutura de Dados Compartilhada

Os DTOs (Data Transfer Objects) compartilhados entre frontend e backend ficam documentados em:
```
docs/api/schemas/
```

## Sincronização com Lovable

O Lovable faz push automático para o repositório GitHub. Para sincronizar:

1. O repo do Lovable é `rodrigedilson/audit-frontend`
2. Este repo (backend) é `rodrigedilson/audit`
3. Ambos compartilham o mesmo padrão de branches
4. Contratos de API são versionados neste repo em `docs/api/`
