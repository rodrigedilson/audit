# 01 - Conceitos Fundamentais

## O que é o Hive Mind?

O **Hive Mind** (Mente da Colmeia) é um sistema de orquestração multi-agente que permite coordenar vários agentes de IA especializados para trabalhar juntos em tarefas de engenharia de software. Cada agente tem um papel definido e expertise específica, e todos se comunicam através de um sistema de memória compartilhada.

### Analogia com uma Colmeia

| Colmeia Real | Hive Mind |
|-------------|-----------|
| Rainha | Queen (tech-lead) - coordena tudo |
| Operárias | Workers (coder, tester, etc.) - executam tarefas |
| Feromônios | Memória compartilhada - comunicação entre agentes |
| Favos de mel | Namespace de memória - armazenamento organizado |
| Dança das abelhas | Protocolos de coordenação - sinalização de tarefas |

---

## Terminologia

### Agentes

| Termo | Definição |
|-------|-----------|
| **Queen** | Agente líder que decompõe tarefas e coordena os workers. No nosso caso, é o `tech-lead`. |
| **Worker** | Agente especializado que executa tarefas específicas. Exemplos: `coder`, `tester`, `architect`. |
| **Agent** | Qualquer participante do hive mind, seja queen ou worker. |
| **Spawn** | Ato de criar e iniciar um agente. |
| **Auto-spawn** | Agentes que são criados automaticamente ao iniciar o hive mind. |
| **On-demand** | Agentes que são criados apenas quando necessários. |

### Topologia

| Termo | Definição |
|-------|-----------|
| **Topologia** | Forma como os agentes se conectam e comunicam. |
| **Hierarchical-Mesh** | Topologia híbrida: hierarquia com a queen no topo, mas workers podem se comunicar entre si (mesh). |
| **Raft Consensus** | Algoritmo de consenso onde um líder mantém o estado autoritativo e replica para seguidores. |
| **Anti-Drift** | Mecanismo que previne que agentes se desviem do objetivo original. |

### Memória

| Termo | Definição |
|-------|-----------|
| **Namespace** | Espaço lógico de armazenamento. O principal é `software-engineering`. |
| **Shared Memory** | Memória acessível por todos os agentes do hive mind. |
| **HNSW** | Hierarchical Navigable Small World - índice para buscas vetoriais rápidas. |
| **Hybrid Backend** | Combinação de memória vetorial (HNSW) e grafo para diferentes tipos de busca. |
| **Sync Interval** | Frequência de sincronização da memória entre agentes (30 segundos). |

### Workflows

| Termo | Definição |
|-------|-----------|
| **Workflow** | Sequência predefinida de agentes para completar um tipo de tarefa. |
| **Pipeline** | Cadeia de agentes onde a saída de um é entrada do próximo. |
| **Quality Gate** | Ponto de verificação onde o reviewer valida a qualidade antes de prosseguir. |
| **Mission** | Uma tarefa de alto nível atribuída ao hive mind (equivalente a uma "phase" do GSD). |

### Integração GSD

| Termo GSD | Equivalente Hive Mind | Agente Responsável |
|-----------|----------------------|-------------------|
| Phase | Mission | tech-lead define |
| Task | Worker Assignment | Especialista executa |
| Verification | Consensus | reviewer valida |
| Roadmap | Queen Strategy | architect desenha |

---

## Como os Agentes se Comunicam?

Os agentes NÃO conversam diretamente entre si. Toda comunicação acontece através da **memória compartilhada**:

```
  Coder                    Memória                    Tester
    |                         |                          |
    |-- store: "código        |                          |
    |   pronto, tests         |                          |
    |   pendentes"            |                          |
    |                         |                          |
    |                         |-- retrieve: "status" --->|
    |                         |                          |
    |                         |<-- store: "testando" ----|
    |                         |                          |
    |<-- retrieve: "progresso"|                          |
    |                         |                          |
```

### Estrutura de Chaves na Memória

```
swarm/
  tech-lead/          # Chaves da queen
    task-plan         # Plano de tarefas atual
    assignments       # Atribuições de trabalho
  shared/             # Chaves compartilhadas
    progress          # Progresso geral
    hierarchy         # Estrutura de comando
  [worker-name]/      # Chaves de cada worker
    status            # Status atual do worker
    progress          # Progresso do trabalho
    complete          # Resultado final
```

---

## Prioridades dos Agentes

Os agentes têm prioridades que determinam a ordem de alocação de recursos:

| Prioridade | Agentes | Significado |
|------------|---------|-------------|
| **critical** | tech-lead, debugger, security-engineer | Sempre disponíveis, recursos garantidos |
| **high** | architect, coder, tester, performance-engineer, devops-engineer | Spawnam automaticamente, alta prioridade |
| **medium** | reviewer, docs-writer | Spawnam sob demanda, prioridade normal |

---

## Auto-Spawn vs On-Demand

### Agentes com Auto-Spawn (iniciam automaticamente)

- `architect` - necessário para design de qualquer feature
- `coder` (2 réplicas) - principal força de trabalho
- `tester` - validação sempre necessária
- `reviewer` - quality gate obrigatório

### Agentes On-Demand (criados quando necessários)

- `debugger` - apenas quando há bugs para investigar
- `security-engineer` - para auditorias de segurança
- `performance-engineer` - para otimizações de performance
- `docs-writer` - para criação de documentação
- `devops-engineer` - para operações de infraestrutura
