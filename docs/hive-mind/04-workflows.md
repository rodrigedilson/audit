# 04 - Workflows

Os workflows são sequências predefinidas de agentes que são ativadas conforme o tipo de tarefa. Cada workflow define a ordem de execução e as dependências entre agentes.

---

## Visão Geral dos Workflows

| Workflow | Objetivo | Agentes Envolvidos | Trigger |
|----------|----------|--------------------|---------|
| **feature** | Implementar funcionalidade nova | tech-lead -> architect -> coder -> tester -> reviewer | Nova feature solicitada |
| **bugfix** | Corrigir bug | debugger -> coder -> tester | Bug reportado |
| **security_audit** | Auditoria de segurança | security-engineer -> coder | Antes de deploy ou mudança sensível |
| **performance_optimization** | Otimizar performance | performance-engineer -> coder -> tester | Problemas de performance |

---

## 1. Workflow: Feature

**Quando usar**: Sempre que uma nova funcionalidade precisa ser implementada.

### Fluxo

```
  tech-lead
  (decompõe a tarefa)
       |
       v
  architect
  (desenha a solução)
       |
       v
  coder
  (implementa o código)
       |
       v
  tester
  (escreve e executa testes)
       |
       v
  reviewer
  (revisa qualidade)
       |
       v
  PRONTO para merge
```

### Detalhes de cada etapa

#### Etapa 1: Tech Lead (Decomposição)
```
Input:  Pedido do usuário (ex: "Criar endpoint de login")
Output: Plano com subtarefas atribuídas

Ações:
- Analisar escopo e dependências
- Quebrar em subtarefas atômicas
- Definir ordem de execução
- Atribuir para agentes via memória
```

#### Etapa 2: Architect (Design)
```
Input:  Subtarefa de design do tech-lead
Output: Especificação técnica (tipos, interfaces, diagrama)

Ações:
- Analisar requisitos funcionais e não-funcionais
- Escolher padrões (DDD, hexagonal, etc.)
- Definir contratos de interface
- Criar ADR se necessário
```

#### Etapa 3: Coder (Implementação)
```
Input:  Especificação do architect
Output: Código implementado e funcional

Ações:
- Seguir especificação do architect
- Usar TDD (escrever teste -> implementar -> refatorar)
- Implementar error handling
- Seguir padrões SOLID/DRY/KISS
```

#### Etapa 4: Tester (Validação)
```
Input:  Código do coder
Output: Suíte de testes completa (unit + integration + edge cases)

Ações:
- Escrever testes unitários (>80% cobertura)
- Escrever testes de integração
- Testar edge cases
- Validar performance básica
```

#### Etapa 5: Reviewer (Quality Gate)
```
Input:  Código + testes
Output: Aprovação ou lista de correções

Ações:
- Verificar funcionalidade
- Verificar segurança
- Verificar performance
- Verificar qualidade de código
- Verificar manutenibilidade
```

### Configuração no hive-mind.yaml

```yaml
workflows:
  feature:
    steps:
      - agent: "tech-lead"
        action: "decompose"
      - agent: "architect"
        action: "design"
      - agent: "coder"
        action: "implement"
      - agent: "tester"
        action: "test"
      - agent: "reviewer"
        action: "review"
```

### Exemplo prático

```
Pedido: "Implementar sistema de autenticação JWT"

Tech Lead decompõe em:
  1. [architect] Desenhar arquitetura de auth (JWT + refresh token)
  2. [coder] Criar middleware de autenticação
  3. [coder] Criar endpoint POST /auth/login
  4. [coder] Criar endpoint POST /auth/refresh
  5. [coder] Criar endpoint POST /auth/logout
  6. [tester] Testes unitários para cada endpoint
  7. [tester] Testes de integração do fluxo completo
  8. [reviewer] Revisar segurança do sistema de auth
```

---

## 2. Workflow: Bugfix

**Quando usar**: Sempre que um bug precisa ser investigado e corrigido.

### Fluxo

```
  debugger
  (investiga a causa raiz)
       |
       v
  coder
  (aplica o fix)
       |
       v
  tester
  (cria teste de regressão)
       |
       v
  PRONTO para merge
```

### Detalhes de cada etapa

#### Etapa 1: Debugger (Investigação)
```
Input:  Descrição do bug, logs, stack traces
Output: Causa raiz identificada + sugestão de fix

Ações:
- Reproduzir o bug
- Formar hipóteses
- Testar cada hipótese
- Identificar causa raiz
- Sugerir fix mínimo
```

#### Etapa 2: Coder (Correção)
```
Input:  Causa raiz + sugestão de fix do debugger
Output: Código corrigido

Ações:
- Aplicar mudança MÍNIMA para corrigir
- NÃO refatorar código ao redor
- Garantir que não quebra nada existente
```

#### Etapa 3: Tester (Regressão)
```
Input:  Fix do coder
Output: Teste de regressão + testes existentes passando

Ações:
- Escrever teste específico para o bug
- Verificar que o teste falha sem o fix
- Verificar que o teste passa com o fix
- Rodar suíte completa de regressão
```

### Configuração no hive-mind.yaml

```yaml
workflows:
  bugfix:
    steps:
      - agent: "debugger"
        action: "investigate"
      - agent: "coder"
        action: "fix"
      - agent: "tester"
        action: "regression-test"
```

### Exemplo prático

```
Bug: "Login retorna 500 quando email tem caracteres especiais"

Debugger:
  Hipótese 1: Validação de email não trata UTF-8 -> CONFIRMADA
  Causa raiz: regex de email não aceita caracteres acentuados
  Fix sugerido: trocar regex por biblioteca de validação (zod)

Coder:
  - Substituir regex manual por z.string().email()
  - Adicionar sanitização de input

Tester:
  - Teste: login com "joão@email.com" -> 200 OK
  - Teste: login com "josé@email.com" -> 200 OK
  - Teste: login com "" -> 400 Bad Request
  - Regressão: todos os 45 testes passando
```

---

## 3. Workflow: Security Audit

**Quando usar**: Antes de deploy em produção ou quando há mudanças em áreas sensíveis (auth, pagamentos, dados pessoais).

### Fluxo

```
  security-engineer
  (modela ameaças - STRIDE)
       |
       v
  security-engineer
  (scan de vulnerabilidades)
       |
       v
  coder
  (remediação)
       |
       v
  PRONTO (seguro)
```

### Detalhes de cada etapa

#### Etapa 1: Threat Modeling (STRIDE)
```
Input:  Código/funcionalidade a ser auditada
Output: Lista de ameaças identificadas com severidade

Ações:
- Aplicar modelo STRIDE
- Identificar superfície de ataque
- Classificar ameaças por severidade
- Priorizar mitigações
```

#### Etapa 2: Vulnerability Scan
```
Input:  Código fonte + dependências
Output: Lista de vulnerabilidades encontradas

Ações:
- SAST (Static Application Security Testing)
- Verificar OWASP Top 10
- Verificar dependências com vulnerabilidades conhecidas
- Verificar configurações de segurança
```

#### Etapa 3: Remediação
```
Input:  Lista de vulnerabilidades priorizadas
Output: Código corrigido e seguro

Ações:
- Corrigir vulnerabilidades por ordem de severidade
- Implementar mitigações recomendadas
- Atualizar dependências vulneráveis
```

### Configuração no hive-mind.yaml

```yaml
workflows:
  security_audit:
    steps:
      - agent: "security-engineer"
        action: "threat-model"
      - agent: "security-engineer"
        action: "scan"
      - agent: "coder"
        action: "remediate"
```

### Exemplo prático

```
Auditoria: "Verificar segurança do módulo de pagamentos"

Security Engineer - Threat Model (STRIDE):
  [CRITICAL] SQL Injection no campo de valor
  [HIGH] Falta de rate limiting no endpoint de pagamento
  [HIGH] Token JWT sem expiração
  [MEDIUM] Logs expondo dados de cartão
  [LOW] Headers de segurança ausentes

Security Engineer - Scan:
  - bandit: 2 issues (SQL injection, hardcoded secret)
  - safety: 1 dependência vulnerável (lodash 4.17.20)
  - OWASP: A01 (Broken Access Control) parcialmente mitigado

Coder - Remediação:
  1. Trocar query raw por parametrizada
  2. Adicionar rate limiting (10 req/min)
  3. Configurar JWT com expiração de 15min
  4. Mascarar dados de cartão nos logs
  5. Atualizar lodash para 4.17.21
```

---

## 4. Workflow: Performance Optimization

**Quando usar**: Quando endpoints estão lentos, consumo de memória alto, ou antes de eventos com pico de tráfego.

### Fluxo

```
  performance-engineer
  (profiling e análise)
       |
       v
  performance-engineer
  (identifica gargalos)
       |
       v
  coder
  (implementa otimizações)
       |
       v
  tester
  (benchmark de validação)
       |
       v
  PRONTO (otimizado)
```

### Detalhes de cada etapa

#### Etapa 1: Profiling
```
Input:  Funcionalidade/endpoint a otimizar
Output: Métricas de performance atuais

Ações:
- Medir CPU, memória, I/O, rede
- Coletar métricas em ambiente de teste
- Identificar métricas que estão acima do budget
```

#### Etapa 2: Análise de Gargalos
```
Input:  Métricas do profiling
Output: Lista de gargalos priorizados com recomendações

Ações:
- Analisar flame graphs e traces
- Identificar hotspots (funções mais lentas)
- Analisar queries de banco (EXPLAIN ANALYZE)
- Identificar N+1, memory leaks, blocking I/O
```

#### Etapa 3: Otimização
```
Input:  Lista de gargalos com recomendações
Output: Código otimizado

Ações:
- Implementar otimizações por impacto (maior primeiro)
- Adicionar cache onde cabível
- Otimizar queries de banco
- Paralelizar operações independentes
```

#### Etapa 4: Benchmark
```
Input:  Código otimizado
Output: Métricas antes/depois + validação de melhoria

Ações:
- Executar mesmos testes de performance
- Comparar métricas antes vs depois
- Validar que não houve regressão funcional
- Documentar ganhos obtidos
```

### Configuração no hive-mind.yaml

```yaml
workflows:
  performance_optimization:
    steps:
      - agent: "performance-engineer"
        action: "profile"
      - agent: "performance-engineer"
        action: "analyze"
      - agent: "coder"
        action: "optimize"
      - agent: "tester"
        action: "benchmark"
```

### Exemplo prático

```
Problema: "Endpoint GET /users demora 3 segundos"

Performance Engineer - Profiling:
  - Response time: 3200ms (p95)
  - DB queries: 47 queries por request (N+1!)
  - Memory: 180MB por request

Performance Engineer - Análise:
  [CRITICAL] N+1 query: carregando orders de cada user individualmente
  [HIGH] Sem cache: mesma query executada repetidamente
  [MEDIUM] Sem paginação: carregando todos os 50k users

Coder - Otimização:
  1. Eager loading: JOIN users com orders (47 queries -> 1)
  2. Cache Redis: TTL 60s para listagem de users
  3. Paginação: limit 20, offset com cursor

Tester - Benchmark:
  ANTES:  3200ms, 47 queries, 180MB
  DEPOIS: 45ms,   1 query,   12MB
  GANHO:  71x mais rápido, 15x menos memória
```

---

## Criando Workflows Customizados

Você pode criar workflows customizados no arquivo `.claude-flow/hive-mind.yaml`:

```yaml
workflows:
  meu_workflow:
    steps:
      - agent: "architect"
        action: "design"
      - agent: "coder"
        action: "implement"
      - agent: "docs-writer"
        action: "document"
```

### Regras para criar workflows

1. Cada step precisa de um `agent` e uma `action`
2. A ordem dos steps define a sequência de execução
3. Um step só inicia quando o anterior termina
4. A queen (tech-lead) sempre supervisiona a execução
5. Use agentes on-demand (debugger, security, etc.) apenas quando necessários
