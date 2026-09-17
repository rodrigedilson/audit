# 05 - Memória e Coordenação

O sistema de memória é o "sistema nervoso" do Hive Mind. Todos os agentes se comunicam, compartilham dados e coordenam trabalho através dele.

---

## Visão Geral

### Backends de Memória

O Hive Mind usa um backend **híbrido** que combina dois tipos de armazenamento:

| Backend | Tipo | Função | Performance |
|---------|------|--------|-------------|
| **HNSW** | Vetorial | Busca semântica (por significado) | 150x-12.500x mais rápido que busca linear |
| **Graph** | Grafo | Relações entre entidades | Consultas de relacionamento rápidas |

### Configuração

```json
// .claude/settings.json
{
  "memory": {
    "backend": "hybrid",
    "enableHNSW": true,
    "learningBridge": { "enabled": true },
    "memoryGraph": { "enabled": true },
    "agentScopes": { "enabled": true }
  }
}
```

---

## Namespaces

Namespaces são espaços lógicos de armazenamento que organizam a memória:

| Namespace | Função | Quem Usa |
|-----------|--------|----------|
| `software-engineering` | Namespace principal do hive mind | Todos os agentes |
| `coordination` | Coordenação de tarefas e status | Queen + workers |
| `patterns` | Padrões de código e arquitetura | Architect + coder |

### Exemplo de uso

```bash
# Armazenar um padrão
npx claude-flow memory store \
  --key "pattern-auth" \
  --value "JWT com refresh token" \
  --namespace patterns

# Buscar padrões
npx claude-flow memory search \
  --query "authentication patterns"

# Listar itens de um namespace
npx claude-flow memory list \
  --namespace patterns \
  --limit 10
```

---

## Estrutura de Chaves

A memória usa uma estrutura hierárquica de chaves no formato `swarm/[agente]/[tipo]`:

```
swarm/
|
+-- tech-lead/            # Chaves da Queen
|   +-- task-plan         # Plano de tarefas atual
|   +-- assignments       # Quem está fazendo o que
|   +-- royal-report      # Relatório de status
|
+-- shared/               # Chaves compartilhadas (todos podem ler)
|   +-- progress          # Progresso geral da missão
|   +-- hierarchy         # Estrutura de comando
|
+-- architect/            # Chaves do architect
|   +-- status            # Status atual
|   +-- progress          # Progresso do trabalho
|   +-- complete          # Resultado final
|
+-- coder/                # Chaves do coder
|   +-- status
|   +-- progress
|   +-- complete
|
+-- tester/               # (mesma estrutura)
+-- reviewer/
+-- debugger/
+-- security-engineer/
+-- performance-engineer/
+-- docs-writer/
+-- devops-engineer/
```

---

## Operações de Memória

### Store (Armazenar)

Salva dados na memória compartilhada. Todos os agentes podem escrever.

```javascript
mcp__claude-flow__memory_usage({
  action: "store",
  key: "swarm/coder/status",
  namespace: "coordination",
  value: {
    agent: "coder",
    status: "working",
    current_task: "Implementar endpoint de login",
    progress: 45,
    timestamp: "2026-03-01T10:30:00Z"
  }
})
```

### Retrieve (Buscar por chave)

Busca um valor específico pela chave exata.

```javascript
mcp__claude-flow__memory_usage({
  action: "retrieve",
  key: "swarm/coder/status",
  namespace: "coordination"
})
```

### Search (Busca semântica)

Busca por significado usando vetores HNSW. Útil quando você não sabe a chave exata.

```javascript
mcp__claude-flow__memory_usage({
  action: "search",
  query: "progresso da implementação de login",
  namespace: "software-engineering"
})
```

### List (Listar)

Lista todas as chaves de um namespace.

```bash
npx claude-flow memory list --namespace coordination --limit 20
```

---

## Sincronização

### Intervalo de Sync

A memória sincroniza entre agentes a cada **30 segundos**:

```yaml
# .claude-flow/hive-mind.yaml
memory:
  sync_interval: "30s"
  shared_keys:
    - "swarm/tech-lead/*"    # Tudo da queen é visível
    - "swarm/shared/*"        # Tudo compartilhado é visível
    - "swarm/*/status"        # Status de todos os workers é visível
```

### Chaves Compartilhadas

Nem todas as chaves são visíveis para todos. A configuração `shared_keys` define quais chaves são sincronizadas:

| Padrão | Significado | Quem Vê |
|--------|-------------|---------|
| `swarm/tech-lead/*` | Tudo da queen | Todos os workers |
| `swarm/shared/*` | Dados compartilhados | Todos os workers |
| `swarm/*/status` | Status de cada worker | Todos os workers |

Chaves que NÃO estão em `shared_keys` são privadas do agente que as criou.

---

## Protocolos de Coordenação

### Protocolo de Status do Worker

Todo worker DEVE seguir este protocolo ao executar uma tarefa:

```
1. INÍCIO - Ao receber a tarefa
   Store: swarm/[worker]/status
   Valor: { status: "starting", task: "...", timestamp: "..." }

2. PROGRESSO - Durante a execução (a cada etapa)
   Store: swarm/[worker]/progress
   Valor: { progress: 30, current_step: "...", blockers: [] }

3. CONCLUSÃO - Ao terminar
   Store: swarm/[worker]/complete
   Valor: { status: "done", deliverables: [...], time_taken: "..." }
```

### Protocolo da Queen

A queen usa a memória para coordenar:

```
1. PLANO - Ao decompor uma tarefa
   Store: swarm/tech-lead/task-plan
   Valor: { subtasks: [...], assignments: {...} }

2. MONITORAMENTO - Periodicamente
   Retrieve: swarm/*/status
   Ação: verifica progresso de cada worker

3. RELATÓRIO - A cada 2 minutos
   Store: swarm/queen/royal-report
   Valor: { completed: [], pending: [], utilization: "85%" }
```

### Resolução de Conflitos

Quando dois agentes escrevem na mesma chave simultaneamente:

```
1. VERSÃO MAIS RECENTE VENCE
   - Cada escrita tem timestamp
   - A escrita mais recente sobrescreve a anterior

2. MERGE SEMÂNTICO (se configurado)
   - CRDT (Conflict-free Replicated Data Types)
   - Vector clocks para detectar conflitos
   - Merge automático quando possível

3. ARBITRAGEM DA QUEEN
   - Em caso de conflito não resolvível
   - A queen decide qual versão manter
```

---

## Cache Multi-Nível

O sistema de memória usa cache em 3 níveis:

```
L1 Cache (Local)
  - Na memória do agente
  - Ultra rápido (<1ms)
  - Invalidado automaticamente a cada sync

L2 Cache (Compartilhado)
  - Na memória do hive mind
  - Rápido (<10ms)
  - Acessível por todos os agentes

L3 Cache (Persistente)
  - No banco de dados SQLite (.swarm/memory.db)
  - Moderado (<50ms)
  - Persiste entre sessões
```

---

## HNSW (Hierarchical Navigable Small World)

O índice HNSW permite buscas semânticas extremamente rápidas:

### O que é?

Em vez de comparar um texto com TODOS os textos armazenados (busca linear), o HNSW cria um "grafo navegável" que permite pular direto para os resultados mais relevantes.

### Performance

| Tipo de Busca | 1.000 docs | 100.000 docs | 1.000.000 docs |
|---------------|-----------|-------------|---------------|
| Linear (sem HNSW) | 10ms | 1.000ms | 10.000ms |
| HNSW | 0.1ms | 1ms | 5ms |
| Ganho | 100x | 1.000x | 2.000x |

### Quando usar cada tipo de busca

| Situação | Use |
|----------|-----|
| Sabe a chave exata | `retrieve` (busca por chave) |
| Busca por significado | `search` (HNSW semântico) |
| Listar tudo | `list` (enumeração) |

---

## Learning Bridge

O Learning Bridge conecta a memória com o sistema de aprendizado:

```json
{
  "learning": {
    "enabled": true,
    "autoTrain": true,
    "patterns": ["coordination", "optimization", "prediction"],
    "retention": {
      "shortTerm": "24h",
      "longTerm": "30d"
    }
  }
}
```

### Como funciona

1. **Coleta**: Observa ações dos agentes e seus resultados
2. **Treinamento**: Identifica padrões de sucesso e falha
3. **Aplicação**: Sugere otimizações baseadas em padrões aprendidos
4. **Retenção**: Memórias de curto prazo (24h) e longo prazo (30 dias)

### Padrões aprendidos

| Padrão | O que aprende |
|--------|---------------|
| `coordination` | Qual agente funciona melhor para cada tipo de tarefa |
| `optimization` | Quais otimizações geram mais impacto |
| `prediction` | Prever quanto tempo uma tarefa vai levar |

---

## Comandos de Memória (CLI)

```bash
# Armazenar valor
npx claude-flow memory store \
  --key "pattern-auth" \
  --value "JWT com refresh token" \
  --namespace patterns

# Buscar por chave
npx claude-flow memory retrieve \
  --key "pattern-auth" \
  --namespace patterns

# Buscar semanticamente
npx claude-flow memory search \
  --query "padrões de autenticação"

# Listar namespace
npx claude-flow memory list \
  --namespace patterns \
  --limit 10

# Inicializar memória
npx claude-flow memory init
```
