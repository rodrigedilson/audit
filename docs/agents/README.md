# Agentes de Engenharia de Software

## Visão Geral

Este projeto utiliza o **Claude Flow v3** com **Hive Mind** para orquestrar uma equipe de agentes especializados em engenharia de software. Cada agente tem um papel bem definido dentro de uma hierarquia coordenada pela topologia `hierarchical-mesh`.

## Arquitetura do Hive Mind

```
                    ┌─────────────────┐
                    │    Tech Lead     │
                    │   (Queen/Rainha) │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
     ┌──────▼──────┐  ┌─────▼─────┐  ┌──────▼──────┐
     │  Architect   │  │   Coder   │  │   Tester    │
     │ (Arquiteto)  │  │(Codador)  │  │ (Testador)  │
     └──────────────┘  └───────────┘  └─────────────┘
            │                │                │
     ┌──────▼──────┐  ┌─────▼─────┐  ┌──────▼──────┐
     │  Reviewer    │  │ Debugger  │  │  Security   │
     │ (Revisor)    │  │(Depurador)│  │ (Segurança) │
     └──────────────┘  └───────────┘  └─────────────┘
            │                │                │
     ┌──────▼──────┐  ┌─────▼─────┐  ┌──────▼──────┐
     │   DevOps     │  │Performance│  │    Docs     │
     │(Infraestrut.)│  │(Desempenh)│  │(Documentaç.)│
     └──────────────┘  └───────────┘  └─────────────┘
```

## Configuração

- **Topologia**: hierarchical-mesh
- **Consenso**: Raft (líder mantém estado autoritativo)
- **Namespace de memória**: `software-engineering`
- **Anti-drift**: Habilitado (checkpoint a cada 5 minutos)
- **Máximo de agentes**: 10 simultâneos

## Agentes

### 1. Tech Lead (Líder Técnico) — Queen/Rainha

**Arquivo**: `.claude/agents/software-engineering/tech-lead.md`
**Prioridade**: Crítica
**Cor**: Azul (#1E90FF)

**Responsabilidades**:
- Decomposição de tarefas complexas em subtarefas atômicas
- Decisões arquiteturais (ADRs - Architecture Decision Records)
- Coordenação da equipe de agentes
- Portão de qualidade antes da integração
- Gestão de débito técnico

**Quando usar**: Tarefas complexas que envolvem múltiplos agentes, features grandes, decisões de arquitetura.

**Fluxo de trabalho**:
1. Recebe requisição do usuário
2. Analisa escopo e complexidade
3. Decompõe em subtarefas
4. Atribui cada subtarefa ao agente especialista
5. Monitora progresso via memória compartilhada
6. Valida qualidade antes da entrega

---

### 2. Architect (Arquiteto)

**Arquivo**: `.claude/agents/software-engineering/architect.md`
**Prioridade**: Alta
**Cor**: Roxo (#9B59B6)

**Responsabilidades**:
- Design de sistema (componentes, fronteiras, fluxos de dados)
- Design de APIs (REST, GraphQL)
- Modelagem de banco de dados
- Seleção de padrões de projeto (Design Patterns)
- Planejamento de escalabilidade

**Quando usar**: Novos módulos, design de APIs, refatoração estrutural, decisões de tecnologia.

**Padrões suportados**:
- Microserviços
- Event-Driven Architecture
- Hexagonal (Ports & Adapters)
- CQRS (Command Query Responsibility Segregation)
- Domain-Driven Design (DDD)

**Critérios de qualidade**:
| Métrica | Alvo |
|---------|------|
| Tempo de resposta da API (p95) | < 200ms |
| Tempo de query no banco (p95) | < 50ms |
| Throughput | > 1000 req/s |
| Complexidade ciclomática | < 10 por função |

---

### 3. Coder (Codificador)

**Arquivo**: `.claude/agents/core/coder.md`
**Prioridade**: Alta
**Cor**: Laranja (#FF6B35)

**Responsabilidades**:
- Implementação de código production-ready
- Design de APIs e interfaces
- Refatoração de código existente
- Otimização de performance
- Tratamento robusto de erros

**Quando usar**: Implementação de features, correção de bugs, refatoração.

**Princípios**:
- SOLID, DRY, KISS, YAGNI
- TDD (Test-Driven Development)
- Injeção de dependências
- Código auto-documentável
- Funções < 20 linhas

---

### 4. Debugger (Depurador)

**Arquivo**: `.claude/agents/software-engineering/debugger.md`
**Prioridade**: Crítica
**Cor**: Vermelho (#E74C3C)

**Responsabilidades**:
- Análise de causa raiz usando método científico
- Análise de stack traces e logs
- Detecção de memory leaks
- Debug por bisseção (git bisect)

**Quando usar**: Bugs em produção, falhas de testes, problemas intermitentes.

**Processo (Método Científico)**:
1. **Observar**: Reproduzir o bug, coletar evidências
2. **Hipotetizar**: Formar teorias sobre a causa raiz
3. **Testar**: Confirmar ou eliminar hipóteses
4. **Corrigir**: Aplicar correção mínima + teste de regressão
5. **Documentar**: Post-mortem para aprendizado da equipe

**Padrões comuns de bugs**:
| Padrão | Sintoma | Causa típica |
|--------|---------|--------------|
| Race condition | Falhas intermitentes | Falta de locks/awaits |
| Memory leak | Memória crescente | Listeners não removidos |
| Off-by-one | Contagem errada | Erro no limite do loop |
| Null reference | Crash inesperado | Falta de null check |
| Mutação de estado | Comportamento imprevisível | Estado mutável compartilhado |

---

### 5. Tester (Testador)

**Arquivo**: `.claude/agents/core/tester.md`
**Prioridade**: Alta
**Cor**: Amarelo (#F39C12)

**Responsabilidades**:
- Design de suítes de teste abrangentes
- Testes unitários, de integração e E2E
- Análise de edge cases e condições de contorno
- Testes de performance e segurança

**Quando usar**: Após implementação, validação de regressão, cobertura de testes.

**Pirâmide de testes**:
```
         /\
        /E2E\        ← Poucos, alto valor
       /------\
      /Integr. \     ← Cobertura moderada
     /----------\
    /   Unit     \   ← Muitos, rápidos, focados
   /--------------\
```

**Metas de cobertura**:
- Statements: > 80%
- Branches: > 75%
- Functions: > 80%
- Lines: > 80%

---

### 6. Reviewer (Revisor)

**Arquivo**: `.claude/agents/core/reviewer.md`
**Prioridade**: Média
**Cor**: Vermelho (#E74C3C)

**Responsabilidades**:
- Revisão de qualidade de código
- Auditoria de segurança
- Análise de performance
- Conformidade com padrões e boas práticas
- Revisão de documentação

**Quando usar**: Antes de merge, portões de qualidade, revisões periódicas.

**Checklist de revisão**:
1. **Funcionalidade**: Atende requisitos? Edge cases tratados?
2. **Segurança**: Validação de entrada? Injeção SQL? XSS?
3. **Performance**: Consultas N+1? Caching? Algoritmos eficientes?
4. **Qualidade**: SOLID? DRY? Nomes claros? Complexidade baixa?
5. **Manutenibilidade**: Testável? Modular? Documentado?

**Classificação de severidade**:
- **Crítico**: Segurança, perda de dados, crashes
- **Major**: Performance, bugs de funcionalidade
- **Minor**: Estilo, nomenclatura, documentação
- **Sugestão**: Melhorias, otimizações opcionais

---

### 7. Security Engineer (Engenheiro de Segurança)

**Arquivo**: `.claude/agents/software-engineering/security-engineer.md`
**Prioridade**: Crítica
**Cor**: Vermelho escuro (#C0392B)

**Responsabilidades**:
- Modelagem de ameaças (STRIDE)
- Avaliação de vulnerabilidades (OWASP Top 10)
- Revisão de código seguro
- Testes de penetração
- Verificação de conformidade

**Quando usar**: Antes de deploy, mudanças sensíveis, auditorias periódicas.

**Framework STRIDE**:
| Ameaça | Descrição | Mitigação |
|--------|-----------|-----------|
| **S**poofing | Falsificação de identidade | Autenticação forte |
| **T**ampering | Modificação de dados | Integridade, assinatura |
| **R**epudiation | Negação de ações | Logs de auditoria |
| **I**nformation Disclosure | Vazamento de dados | Criptografia, controle de acesso |
| **D**enial of Service | Interrupção de serviço | Rate limiting, escalabilidade |
| **E**levation of Privilege | Acesso não autorizado | RBAC, menor privilégio |

---

### 8. Performance Engineer (Engenheiro de Performance)

**Arquivo**: `.claude/agents/software-engineering/performance-engineer.md`
**Prioridade**: Alta
**Cor**: Verde (#27AE60)

**Responsabilidades**:
- Profiling de CPU, memória, I/O e rede
- Identificação de gargalos (bottlenecks)
- Otimização de caminhos críticos
- Estratégia de caching
- Testes de carga

**Quando usar**: Endpoints lentos, problemas de escalabilidade, otimização.

**Orçamento de performance**:
| Métrica | Alvo | Crítico |
|---------|------|---------|
| API Response (p50) | < 100ms | > 500ms |
| API Response (p95) | < 200ms | > 1000ms |
| Page Load (LCP) | < 2.5s | > 4s |
| Memória por request | < 50MB | > 200MB |
| Query no banco | < 20ms | > 100ms |
| Throughput | > 1000 rps | < 100 rps |

**Camadas de cache**:
```
Cliente (Browser) → CDN → Cache da API (Redis) → Cache do Banco → Banco de Dados
```

---

### 9. Docs Writer (Escritor de Documentação)

**Arquivo**: `.claude/agents/software-engineering/docs-writer.md`
**Prioridade**: Média
**Cor**: Azul (#3498DB)

**Responsabilidades**:
- Documentação de API (OpenAPI/Swagger)
- Documentação de arquitetura (diagramas, ADRs)
- Guias para desenvolvedores
- Runbooks operacionais
- Changelogs e guias de migração

**Quando usar**: APIs estáveis, documentação de arquitetura, onboarding.

**Tipos de documentação**:
1. **API Reference**: Especificações OpenAPI 3.0
2. **ADRs**: Architecture Decision Records
3. **Runbooks**: Procedimentos operacionais
4. **Guias**: Setup, contribuição, padrões de código

---

### 10. DevOps Engineer (Engenheiro DevOps)

**Arquivo**: `.claude/agents/software-engineering/devops-engineer.md`
**Prioridade**: Alta
**Cor**: Amarelo (#F39C12)

**Responsabilidades**:
- Pipelines CI/CD (GitHub Actions)
- Infraestrutura como código (Terraform, Pulumi)
- Containerização (Docker, Kubernetes)
- Monitoramento e observabilidade
- Automação de deploy

**Quando usar**: Setup de pipeline, containerização, deploy, monitoramento.

**Pipeline padrão**:
```
lint → test → security → build → staging → e2e → production → smoke
```

**Estratégias de deploy**:
- **Blue-Green**: Zero-downtime com rollback instantâneo
- **Canary**: Rollout gradual com monitoramento
- **Rolling**: Substituição incremental de pods
- **Feature Flags**: Toggle a nível de código

## Workflows Predefinidos

### 1. Feature (Desenvolvimento de Funcionalidade)
```
Tech Lead → Architect → Coder → Tester → Reviewer
```

### 2. Bugfix (Correção de Bug)
```
Debugger → Coder → Tester (regressão)
```

### 3. Security Audit (Auditoria de Segurança)
```
Security Engineer → Scan → Coder (remediação)
```

### 4. Performance Optimization (Otimização de Performance)
```
Performance Engineer → Análise → Coder → Tester (benchmark)
```

## Integração com GSD

| Conceito GSD | Equivalente Hive Mind | Agente Responsável |
|--------------|----------------------|-------------------|
| Phase (Fase) | Mission (Missão) | Tech Lead atribui |
| Task (Tarefa) | Worker Assignment | Especialista executa |
| Verification | Consensus | Reviewer valida |
| Roadmap | Queen Strategy | Architect projeta |

## Como Usar

### Inicializar o Hive Mind
```bash
bash scripts/init-hive.sh
```

### Submeter uma tarefa ao Hive
```bash
npx claude-flow hive-mind task -d "Implementar autenticação JWT"
```

### Verificar status
```bash
npx claude-flow hive-mind status
```

### Buscar na memória compartilhada
```bash
npx claude-flow memory search --query "autenticação" --namespace software-engineering
```
