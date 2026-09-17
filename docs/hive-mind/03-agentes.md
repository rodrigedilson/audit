# 03 - Agentes

Este guia detalha todos os agentes disponíveis no Hive Mind, suas funções, capacidades e quando usá-los.

---

## Resumo dos Agentes

| # | Agente | Papel | Prioridade | Auto-Spawn | Cor |
|---|--------|-------|------------|------------|-----|
| 1 | tech-lead | Queen/Coordenador | critical | - | #1E90FF |
| 2 | architect | Designer de Sistema | high | sim | #9B59B6 |
| 3 | coder | Desenvolvedor | high | sim (x2) | #FF6B35 |
| 4 | debugger | Investigador de Bugs | critical | não | #E74C3C |
| 5 | tester | Validador/QA | high | sim | #F39C12 |
| 6 | reviewer | Revisor de Qualidade | medium | sim | #E74C3C |
| 7 | security-engineer | Engenheiro de Segurança | critical | não | #C0392B |
| 8 | performance-engineer | Engenheiro de Performance | high | não | #27AE60 |
| 9 | docs-writer | Escritor de Documentação | medium | não | #3498DB |
| 10 | devops-engineer | Engenheiro de Operações | high | não | #F39C12 |

---

## 1. Tech Lead (Queen)

**Arquivo**: `.claude/agents/software-engineering/tech-lead.md`
**Papel**: Coordenador principal - a "rainha" do hive mind
**Prioridade**: critical

### O que faz

O Tech Lead é o agente central que recebe todos os pedidos e os decompõe em subtarefas para os workers. Ele NÃO implementa código, apenas coordena.

### Responsabilidades

1. **Decomposição de Tarefas**: Recebe uma tarefa complexa e a quebra em subtarefas atômicas
2. **Decisões Arquiteturais**: Participa de ADRs (Architecture Decision Records) com o architect
3. **Coordenação de Time**: Atribui trabalho aos agentes via memória compartilhada
4. **Quality Gate**: Valida entregas antes da integração final
5. **Dívida Técnica**: Rastreia e prioriza redução de tech debt

### Fluxo de Trabalho

```
1. Receber & Analisar
   - Compreender escopo completo do pedido
   - Identificar dependências e riscos

2. Decompor em Subtarefas
   - Criar plano de execução detalhado
   - Definir ordem de execução
   - Identificar paralelismo possível

3. Atribuir & Coordenar
   - Rotear subtarefas para agentes via memória
   - Monitorar progresso de cada worker
   - Resolver bloqueios

4. Quality Gate
   - Verificar: testes passando?
   - Verificar: arquitetura respeitada?
   - Verificar: segurança OK?
   - Verificar: documentação atualizada?
```

### Como a Queen publica tarefas

```javascript
// A queen armazena o plano na memória compartilhada
mcp__claude-flow__memory_usage({
  action: "store",
  key: "swarm/tech-lead/task-plan",
  namespace: "coordination",
  value: {
    agent: "tech-lead",
    task: "Implementar auth JWT",
    subtasks: [
      { id: 1, agent: "architect", task: "Design da arquitetura" },
      { id: 2, agent: "coder", task: "Implementar endpoints", depends: [1] },
      { id: 3, agent: "tester", task: "Escrever testes", depends: [2] }
    ],
    status: "in_progress",
    timestamp: "2026-03-01T06:30:00Z"
  }
})
```

---

## 2. Architect

**Arquivo**: `.claude/agents/software-engineering/architect.md`
**Papel**: Designer de sistema e padrões
**Prioridade**: high | **Auto-Spawn**: sim

### O que faz

O Architect desenha a estrutura do sistema, define interfaces, escolhe padrões e cria especificações técnicas que os coders seguem.

### Responsabilidades

1. **System Design**: Define limites de componentes, interações e fluxos de dados
2. **API Design**: Cria especificações RESTful ou GraphQL
3. **Database Modeling**: Modela dados eficientemente
4. **Pattern Selection**: Escolhe padrões apropriados (Hexagonal, CQRS, Event-Driven, etc.)
5. **Scalability Planning**: Garante que a arquitetura suporta crescimento

### Capacidades

- `system_design` - Desenho de sistemas
- `api_design` - Design de APIs
- `database_modeling` - Modelagem de dados

### Padrões Utilizados

| Padrão | Quando Usar |
|--------|-------------|
| Hexagonal (Ports & Adapters) | Isolar domínio de infraestrutura |
| CQRS | Separar leitura de escrita |
| Event-Driven | Comunicação assíncrona entre módulos |
| Microservices | Escalar independentemente |
| DDD (Domain-Driven Design) | Modelar domínios complexos |

### Métricas de Qualidade

| Métrica | Target |
|---------|--------|
| API Response (p95) | < 200ms |
| DB Query (p95) | < 50ms |
| Throughput | > 1000 rps |
| Complexidade Ciclomática | < 10 |
| Acoplamento | Baixo |
| Coesão | Alta |

### Output típico

O architect produz:
- Diagramas de componentes
- Contratos de interface (tipos TypeScript)
- ADRs (Architecture Decision Records)
- Especificações de API

---

## 3. Coder

**Arquivo**: `.claude/agents/software-engineering/coder.md`
**Papel**: Desenvolvedor - implementa código
**Prioridade**: high | **Auto-Spawn**: sim (2 réplicas)

### O que faz

O Coder é o "braço executor" do hive mind. Ele recebe especificações do architect e as transforma em código funcional.

### Responsabilidades

1. **Implementação de Código**: Escreve código production-ready
2. **API Design**: Cria interfaces intuitivas e bem documentadas
3. **Refatoração**: Melhora código sem alterar funcionalidade
4. **Otimização**: Melhora performance mantendo legibilidade
5. **Tratamento de Erros**: Implementa error handling robusto

### Capacidades

- `code_generation` - Geração de código
- `refactoring` - Refatoração
- `optimization` - Otimização de performance

### Princípios que segue

| Princípio | Descrição |
|-----------|-----------|
| SOLID | Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion |
| DRY | Don't Repeat Yourself - não duplicar lógica |
| KISS | Keep It Simple - preferir simplicidade |
| YAGNI | You Ain't Gonna Need It - não implementar o que não foi pedido |

### Processo TDD

```
1. Escrever teste (RED)
   - Teste falha porque o código não existe

2. Implementar mínimo (GREEN)
   - Escrever o mínimo para o teste passar

3. Refatorar (REFACTOR)
   - Melhorar o código mantendo testes verdes
```

### Por que 2 réplicas?

O hive mind spawna 2 instâncias do coder porque:
- Permite **paralelismo**: 2 features podem ser implementadas simultaneamente
- Um coder pode trabalhar no backend enquanto outro trabalha no frontend
- Em bugfixes urgentes, um coder não precisa parar sua feature

---

## 4. Debugger

**Arquivo**: `.claude/agents/software-engineering/debugger.md`
**Papel**: Investigador de bugs
**Prioridade**: critical | **Auto-Spawn**: não (on-demand)

### O que faz

O Debugger usa o **método científico** para investigar bugs. Ele NÃO adivinha - ele forma hipóteses e as testa sistematicamente.

### Responsabilidades

1. **Root Cause Analysis**: Encontra a causa real, não apenas sintomas
2. **Hypothesis Testing**: Forma e testa teorias sistematicamente
3. **Fix Implementation**: Cria fixes mínimas e direcionadas
4. **Regression Tests**: Garante que bugs não retornem
5. **Post-Mortem**: Documenta aprendizados

### Método Científico de Debug

```
1. OBSERVAR
   - Reproduzir o bug
   - Coletar mensagens de erro, stack traces, logs
   - Documentar passos para reproduzir

2. HIPOTETIZAR
   - Formar múltiplas teorias sobre a causa
   - Priorizar por probabilidade
   - Exemplo: "Pode ser race condition no cache"

3. TESTAR
   - Desenhar experimentos para cada hipótese
   - Confirmar ou eliminar cada teoria
   - Usar logs estratégicos, breakpoints, bisect

4. CORRIGIR
   - Aplicar mudança MÍNIMA para corrigir
   - Não refatorar código ao redor
   - Focar apenas no bug

5. DOCUMENTAR
   - Registrar causa raiz
   - Escrever teste de regressão
   - Compartilhar aprendizado
```

### Técnicas de Investigação

| Técnica | Quando Usar |
|---------|-------------|
| Stack Trace Analysis | Erros com stacktrace disponível |
| Git Bisect | Bug introduzido em algum commit recente |
| Logging Estratégico | Bug intermitente ou difícil de reproduzir |
| Binary Search | Isolar qual componente causa o problema |

### Padrões Comuns de Bugs

- **Race Conditions**: Operações concorrentes sem sincronização
- **Memory Leaks**: Recursos não liberados após uso
- **Off-by-One**: Índices fora do limite de arrays/loops
- **Null References**: Acesso a propriedades de valores nulos

---

## 5. Tester

**Arquivo**: `.claude/agents/software-engineering/tester.md`
**Papel**: Validador de qualidade
**Prioridade**: high | **Auto-Spawn**: sim

### O que faz

O Tester cria e executa suítes de teste abrangentes para garantir que o código funciona corretamente em todos os cenários.

### Responsabilidades

1. **Design de Testes**: Cria suítes de teste abrangentes
2. **Implementação de Testes**: Escreve código de teste claro e mantível
3. **Análise de Edge Cases**: Identifica e testa condições limite
4. **Validação de Performance**: Garante que o código atende requisitos
5. **Testes de Segurança**: Valida medidas de proteção

### Pirâmide de Testes

```
       /\
      /E2E\          Poucos, alto valor
     /------\        Simulam usuário real
    /Integraç\       Cobertura moderada
   /----------\      Testa com recursos reais
  /  Unitários \     Muitos, rápidos, focados
 /--------------\    Mocka dependências
```

### Tipos de Teste

| Tipo | Descrição | Velocidade | Quantidade |
|------|-----------|------------|------------|
| **Unitário** | Testa função isolada, mocka deps | < 100ms | Muitos |
| **Integração** | Testa com banco, API real | 1-5s | Moderado |
| **E2E** | Simula fluxo completo do usuário | 10-30s | Poucos |
| **Edge Cases** | Valores limite, null, erro | < 100ms | Muitos |
| **Performance** | Latência, memória, throughput | Varia | Poucos |

### Metas de Cobertura

| Métrica | Target Mínimo |
|---------|---------------|
| Statements | > 80% |
| Branches | > 75% |
| Functions | > 80% |
| Lines | > 80% |

### Características FIRST de Bons Testes

| Letra | Significado | Descrição |
|-------|-------------|-----------|
| **F** | Fast | < 100ms para unitários |
| **I** | Isolated | Sem dependências entre testes |
| **R** | Repeatable | Mesmo resultado sempre |
| **S** | Self-validating | Pass/fail claro |
| **T** | Timely | Escrito com ou antes do código |

---

## 6. Reviewer

**Arquivo**: `.claude/agents/software-engineering/reviewer.md`
**Papel**: Revisor de qualidade
**Prioridade**: medium | **Auto-Spawn**: sim

### O que faz

O Reviewer é o "quality gate" do hive mind. Nenhum código vai para produção sem passar pela revisão dele.

### Responsabilidades

1. **Code Quality Review**: Avalia estrutura, legibilidade, manutenibilidade
2. **Security Audit**: Identifica vulnerabilidades de segurança
3. **Performance Analysis**: Detecta oportunidades de otimização
4. **Standards Compliance**: Garante aderência a padrões do projeto
5. **Documentation Review**: Verifica se documentação está adequada

### Checklist de Revisão

#### 1. Funcionalidade
- Requisitos foram atendidos?
- Edge cases estão tratados?
- Cenários de erro estão cobertos?
- Lógica de negócio está correta?

#### 2. Segurança
- Input validation presente?
- Output encoding aplicado?
- Autenticação/autorização corretas?
- Dados sensíveis protegidos?
- SQL injection prevenida?
- XSS prevenido?

#### 3. Performance
- Algoritmos são eficientes?
- Queries de banco otimizadas?
- Cache utilizado onde cabível?
- Memória usada eficientemente?
- Operações assíncronas onde possível?

#### 4. Qualidade de Código
- Princípios SOLID respeitados?
- DRY (sem duplicação)?
- KISS (simples)?
- Naming consistente e claro?
- Abstrações apropriadas?

#### 5. Manutenibilidade
- Código autoexplicativo?
- Testável?
- Modular?
- Dependências bem gerenciadas?

### Priorização de Issues

| Severidade | Exemplos | Ação |
|------------|----------|------|
| **Critical** | Vulnerabilidade de segurança, perda de dados, crash | Bloqueia merge |
| **Major** | Problema de performance, bug funcional | Corrigir antes do merge |
| **Minor** | Estilo, naming, documentação | Pode corrigir depois |
| **Suggestion** | Melhoria, otimização opcional | A critério do autor |

---

## 7. Security Engineer

**Arquivo**: `.claude/agents/software-engineering/security-engineer.md`
**Papel**: Engenheiro de segurança
**Prioridade**: critical | **Auto-Spawn**: não (on-demand)

### O que faz

O Security Engineer identifica e mitiga ameaças de segurança usando o modelo **STRIDE** e o checklist **OWASP Top 10**.

### Responsabilidades

1. **Threat Modeling (STRIDE)**: Identifica ameaças sistematicamente
2. **Secure Code Review**: Encontra vulnerabilidades no código
3. **Vulnerability Assessment**: Testa contra OWASP Top 10
4. **Security Architecture**: Desenha limites e controles seguros
5. **Compliance**: Garante aderência a standards de segurança

### Modelo STRIDE

| Ameaça | Descrição | Mitigação |
|--------|-----------|-----------|
| **S**poofing | Personificação de identidade | Autenticação forte |
| **T**ampering | Modificação de dados | Verificação de integridade, assinaturas |
| **R**epudiation | Negar ações realizadas | Logs de auditoria |
| **I**nformation Disclosure | Vazamento de dados | Criptografia, controle de acesso |
| **D**enial of Service | Interrupção de serviço | Rate limiting, scaling |
| **E**levation of Privilege | Acesso não autorizado | Princípio de menor privilégio, RBAC |

### Checklist de Segurança

#### Validação de Input
```typescript
// CORRETO: Valida com schema
const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100).regex(/^[a-zA-Z\s]+$/)
});

// ERRADO: Confia no input do usuário
const name = req.body.name; // Sem validação!
```

#### Autenticação
- JWT com expiração curta + refresh tokens
- MFA para operações sensíveis
- Senhas hasheadas com bcrypt/argon2

#### Autorização
- RBAC (Role-Based Access Control)
- Princípio do menor privilégio
- Verificar permissões em cada endpoint

#### Proteção de Dados
- Criptografia em repouso e em trânsito (TLS)
- Nunca armazenar senhas em texto plano
- Sanitizar outputs para prevenir XSS
- Queries parametrizadas para prevenir SQL injection

#### Gerenciamento de Secrets
- NUNCA hardcodar secrets no código
- Usar variáveis de ambiente ou secret managers
- Rotacionar credenciais regularmente
- Auditar acesso a secrets

---

## 8. Performance Engineer

**Arquivo**: `.claude/agents/software-engineering/performance-engineer.md`
**Papel**: Engenheiro de performance
**Prioridade**: high | **Auto-Spawn**: não (on-demand)

### O que faz

O Performance Engineer mede, analisa e otimiza a performance do sistema usando profiling, benchmarks e estratégias de caching.

### Responsabilidades

1. **Profiling**: Mede CPU, memória, I/O e rede
2. **Análise de Gargalos**: Identifica hotspots e bottlenecks
3. **Otimização**: Implementa melhorias direcionadas
4. **Estratégia de Cache**: Desenha camadas de cache efetivas
5. **Load Testing**: Valida performance sob stress

### Budget de Performance

| Métrica | Target | Crítico |
|---------|--------|---------|
| API Response (p50) | < 100ms | > 500ms |
| API Response (p95) | < 200ms | > 1000ms |
| Page Load (LCP) | < 2.5s | > 4s |
| Memória por request | < 50MB | > 200MB |
| Tempo de query DB | < 20ms | > 100ms |
| Throughput | > 1000 rps | < 100 rps |

### Estratégias de Otimização

#### Database
| Estratégia | Descrição |
|------------|-----------|
| Index Optimization | Criar índices para queries frequentes |
| Query Plan Analysis | Usar EXPLAIN ANALYZE para entender execução |
| N+1 Elimination | Eager loading em vez de queries em loop |
| Connection Pooling | Pool de conexões em vez de criar/destruir |
| Read Replicas | Réplicas para leitura em workloads read-heavy |

#### Aplicação
| Estratégia | Descrição |
|------------|-----------|
| Memoization | Cachear resultados de funções caras |
| Streaming | Processar dados em stream, não tudo em memória |
| Worker Threads | Threads separadas para tarefas CPU-intensive |
| Lazy Loading | Carregar dados apenas quando necessários |
| Promise.all | Executar operações independentes em paralelo |

#### Camadas de Cache

```
Browser Cache --> CDN --> API Cache (Redis) --> DB Cache --> Database
  (segundos)    (min)    (segundos/min)       (interno)   (persistente)
```

---

## 9. Docs Writer

**Arquivo**: `.claude/agents/software-engineering/docs-writer.md`
**Papel**: Escritor de documentação técnica
**Prioridade**: medium | **Auto-Spawn**: não (on-demand)

### O que faz

O Docs Writer cria e mantém toda a documentação técnica do projeto, desde API docs até runbooks operacionais.

### Responsabilidades

1. **API Documentation**: Especificações OpenAPI/Swagger
2. **Architecture Docs**: Diagramas, descrições de componentes, ADRs
3. **Developer Guides**: Setup, contributing, standards de código
4. **Runbooks**: Procedimentos operacionais e incident response
5. **Changelogs**: Histórico de versões e migration guides

### Tipos de Documentação

| Tipo | Formato | Audiência |
|------|---------|-----------|
| API Reference | OpenAPI 3.0 (YAML) | Desenvolvedores |
| ADR | Markdown template | Equipe técnica |
| Runbook | Markdown com comandos | SRE/DevOps |
| Developer Guide | Markdown narrativo | Novos desenvolvedores |
| Changelog | Markdown (semver) | Todos |

### Princípios de Escrita

1. **Audiência primeiro**: Escreva para o nível de expertise do leitor
2. **Orientado a tarefas**: Foque no que o usuário precisa fazer
3. **Consistente**: Use templates e style guides
4. **Atualizado**: Docs desatualizados são piores que nenhum doc
5. **Exemplos**: Sempre inclua exemplos funcionais

---

## 10. DevOps Engineer

**Arquivo**: `.claude/agents/software-engineering/devops-engineer.md`
**Papel**: Engenheiro de operações e infraestrutura
**Prioridade**: high | **Auto-Spawn**: não (on-demand)

### O que faz

O DevOps Engineer cuida de toda a infraestrutura, CI/CD, containers e monitoramento.

### Responsabilidades

1. **CI/CD Pipelines**: Automação de build, test e deploy
2. **Infrastructure as Code**: Terraform, CloudFormation, Pulumi
3. **Containerização**: Docker, Kubernetes, Compose
4. **Monitoramento**: Métricas, logging, alerting, observabilidade
5. **Deploy**: Blue-green, canary, rolling updates

### Pipeline CI/CD

```
lint --> test --> security --> build --> staging --> e2e --> production --> smoke
 |       |         |           |          |        |          |           |
 |   Unitários  SAST/Deps  Container  Deploy   Testes    Deploy      Verif.
 |   + Integr.             Image      Stage    Completos  Prod       pós-deploy
 |
Qualidade
de Código
```

### Stack de Monitoramento

| Camada | Ferramenta | Função |
|--------|-----------|--------|
| Métricas | Prometheus/Grafana | Rastrear performance |
| Logging | ELK/Loki | Agregar logs |
| Tracing | Jaeger/Tempo | Rastrear requests |
| Alerting | PagerDuty/OpsGenie | Notificar incidentes |

### Estratégias de Deploy

| Estratégia | Descrição | Risco | Rollback |
|------------|-----------|-------|----------|
| **Blue-Green** | Dois ambientes idênticos, switch instantâneo | Baixo | Instantâneo |
| **Canary** | Rollout gradual (1% -> 10% -> 50% -> 100%) | Baixo | Rápido |
| **Rolling** | Substituição incremental de pods | Médio | Médio |
| **Feature Flags** | Toggle em nível de código | Baixo | Instantâneo |
