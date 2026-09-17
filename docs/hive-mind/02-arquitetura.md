# 02 - Arquitetura e Topologia

## Visão Geral da Arquitetura

O Hive Mind usa a topologia **hierarchical-mesh**, que combina:

- **Hierarquia**: a Queen (tech-lead) está no topo e coordena todos os workers
- **Mesh**: os workers podem se comunicar entre si diretamente via memória compartilhada

```
                    +------------------+
                    |   QUEEN          |
                    |   (tech-lead)    |
                    +--------+---------+
                             |
          +------------------+------------------+
          |         |        |        |         |
     +----+---+ +--+---+ +--+---+ +--+----+ +--+----+
     |architect| |coder | |coder | |tester | |reviewer|
     +----+---+ +--+---+ +--+---+ +--+----+ +--+----+
          |         |        |        |         |
          +-------- mesh (comunicação direta) --+
          |                                     |
     +----+--------+ +--------+----+ +----+--------+
     |security-eng | |perf-eng    | |devops-eng   |
     +-------------+ +------------+ +-------------+
          |               |               |
     +----+---+
     |docs-   |
     |writer  |
     +---------+
```

---

## Topologia Hierarchical-Mesh

### Por que essa topologia?

| Topologia | Vantagem | Desvantagem | Quando usar |
|-----------|----------|-------------|-------------|
| **Hierárquica pura** | Controle claro | Gargalo na queen | Tarefas simples |
| **Mesh pura** | Flexível | Difícil coordenar | Pesquisa distribuída |
| **Hierarchical-Mesh** | Controle + flexibilidade | Mais complexo | Engenharia de software |

### Como funciona

1. **Fluxo de comando** (hierarquia): a queen decompõe tarefas e atribui para workers
2. **Fluxo de dados** (mesh): workers compartilham informações entre si sem passar pela queen
3. **Fluxo de consenso** (raft): decisões arquiteturais exigem consenso entre agentes

### Exemplo prático

```
Queen recebe: "Implementar autenticação JWT"
  |
  +-> Architect: "Desenhe a arquitetura de auth"
  |     |
  |     +-> (mesh) Comunica com Security-Engineer sobre padrões
  |
  +-> Coder: "Implemente conforme design do Architect"
  |     |
  |     +-> (mesh) Busca decisões do Architect na memória
  |
  +-> Tester: "Teste a implementação do Coder"
        |
        +-> (mesh) Busca specs do Architect na memória
```

---

## Consenso Raft

O algoritmo **Raft** garante que todos os agentes concordem sobre o estado do sistema.

### Como funciona o Raft

```
1. ELEIÇÃO DO LÍDER
   - A Queen (tech-lead) é o líder padrão
   - Se a Queen ficar indisponível, um novo líder é eleito
   - Eleição usa timeouts aleatórios para evitar conflitos

2. REPLICAÇÃO DE LOG
   - Queen escreve decisões no log
   - Decisões são replicadas para todos os workers
   - Uma decisão só é "commitada" quando a maioria confirma

3. CONSISTÊNCIA
   - Todos os agentes têm a mesma visão do estado
   - Em caso de conflito, o estado do líder prevalece
```

### Quando o consenso é necessário

| Tipo de Decisão | Consenso Necessário? | Quem Decide |
|-----------------|---------------------|-------------|
| Decisão arquitetural | Sim | Architect + Queen + consenso |
| Atribuição de tarefa | Não | Queen decide sozinha |
| Padrão de código | Sim | Reviewer + Queen + consenso |
| Deploy em produção | Sim | DevOps + Queen + consenso |
| Fix de bug simples | Não | Debugger + Coder |

---

## Anti-Drift

O **Anti-Drift** é um mecanismo que previne que os agentes se desviem do objetivo original da tarefa.

### Configuração

```yaml
anti_drift:
  enabled: true
  checkpoint_interval: "5m"     # Verifica a cada 5 minutos
  max_drift_score: 0.3          # Tolerância máxima de desvio (0 a 1)
  recovery_strategy: "queen-realign"  # Queen realinha os agentes
```

### Como funciona

```
A cada 5 minutos:
  |
  +-> Calcular drift score de cada agente
  |     - Compara trabalho atual com objetivo original
  |     - Score de 0 (alinhado) a 1 (desalinhado)
  |
  +-> Se drift > 0.3:
  |     - Queen é notificada
  |     - Queen emite correção de rumo
  |     - Worker recebe nova orientação
  |
  +-> Se drift <= 0.3:
        - Tudo normal, continua trabalhando
```

### Exemplo de drift

```
Objetivo: "Implementar endpoint de login"

Worker sem drift (score 0.1):
  - Criando rota POST /auth/login
  - Validando credenciais
  - Gerando JWT

Worker com drift (score 0.5):
  - Refatorando toda a camada de middleware
  - Criando sistema de cache genérico
  - Mudando ORM do projeto inteiro
```

---

## Integração com GSD (Get Stuff Done)

O GSD é um framework de planejamento que se integra com o Hive Mind:

```
GSD Planning                    Hive Mind Execution
+-----------+                   +------------------+
| Phase     | ---- mapeia ----> | Mission          |
| (o que)   |                   | (como)           |
+-----------+                   +------------------+
     |                                   |
     v                                   v
+-----------+                   +------------------+
| Task      | ---- atribui ---> | Worker Assignment|
| (item)    |                   | (quem faz)       |
+-----------+                   +------------------+
     |                                   |
     v                                   v
+-----------+                   +------------------+
| Verify    | ---- valida ----> | Consensus        |
| (pronto?) |                   | (todos concordam)|
+-----------+                   +------------------+
```

### Fluxo completo GSD + Hive Mind

1. `gsd:plan-phase` → Define O QUE construir
2. `gsd:execute-phase` → Hive Mind coordena QUEM constrói
3. Agentes especializados → Executam COMO construir
4. `gsd:verify-work` → Reviewer + Tester validam resultado

---

## Configuração da Topologia

### Arquivo: `.claude-flow/hive-mind.yaml`

```yaml
hive:
  name: "software-engineering-hive"
  topology: "hierarchical-mesh"
  consensus: "raft"
  max_agents: 10

queen:
  agent: "tech-lead"
  capabilities:
    - task_decomposition
    - architecture_decisions
    - team_coordination
    - quality_gate

workers:
  - name: "architect"
    role: "system-design"
    auto_spawn: true

  - name: "coder"
    role: "implementation"
    replicas: 2              # 2 instâncias de coder
    auto_spawn: true

  - name: "tester"
    role: "validation"
    auto_spawn: true

  # ... (demais workers)
```

### Arquivo: `.claude/settings.json` (seção hiveMind)

```json
{
  "hiveMind": {
    "enabled": true,
    "topology": "hierarchical-mesh",
    "consensus": "raft",
    "queen": "tech-lead",
    "workers": [
      "architect", "coder", "debugger", "tester",
      "reviewer", "security-engineer",
      "performance-engineer", "docs-writer",
      "devops-engineer"
    ],
    "sharedMemoryNamespace": "software-engineering",
    "antiDrift": {
      "enabled": true,
      "checkpointInterval": "5m",
      "maxDriftScore": 0.3
    }
  }
}
```
