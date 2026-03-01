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
