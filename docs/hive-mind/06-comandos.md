# 06 - Comandos CLI

Referência completa de todos os comandos do `claude-flow` para operar o Hive Mind.

---

## Inicialização

### Inicializar o Hive Mind

```bash
# Inicializar com topologia hierarchical-mesh (padrão do projeto)
npx claude-flow hive-mind init -t hierarchical-mesh

# Outras topologias disponíveis
npx claude-flow hive-mind init -t hierarchical
npx claude-flow hive-mind init -t mesh
npx claude-flow hive-mind init -t star
```

### Script de inicialização completa

```bash
# Executa todos os passos de inicialização
bash scripts/init-hive.sh
```

O script faz:
1. Inicializa memória (`npx claude-flow memory init`)
2. Inicializa hive mind (`npx claude-flow hive-mind init -t hierarchical-mesh`)
3. Inicializa swarm (`npx claude-flow swarm init`)
4. Verifica status

### Inicializar Swarm (modo V3)

```bash
npx claude-flow swarm init --v3-mode
npx claude-flow swarm init --topology hierarchical --max-agents 10 --strategy specialized
```

---

## Hive Mind

### Verificar status

```bash
npx claude-flow hive-mind status
```

Retorna:
- Estado da queen (ativa/inativa)
- Lista de workers ativos
- Memória compartilhada
- Anti-drift score

### Spawnar agentes

```bash
# Spawnar N agentes conforme configuração
npx claude-flow hive-mind spawn -n 8

# Spawnar com Claude e objetivo específico
npx claude-flow hive-mind spawn --claude -o "Implementar feature de autenticação"

# Spawnar agente individual
npx claude-flow agent spawn -t coder --name my-coder
npx claude-flow agent spawn -t architect --name my-architect
npx claude-flow agent spawn -t tester --name my-tester
```

### Listar agentes ativos

```bash
npx claude-flow agent list
```

---

## Agentes

### Spawnar agente específico

```bash
# Sintaxe: npx claude-flow agent spawn -t [tipo] --name [nome]
npx claude-flow agent spawn -t tech-lead --name lead-1
npx claude-flow agent spawn -t architect --name arch-1
npx claude-flow agent spawn -t coder --name coder-1
npx claude-flow agent spawn -t coder --name coder-2
npx claude-flow agent spawn -t debugger --name debug-1
npx claude-flow agent spawn -t tester --name test-1
npx claude-flow agent spawn -t reviewer --name review-1
npx claude-flow agent spawn -t security-engineer --name sec-1
npx claude-flow agent spawn -t performance-engineer --name perf-1
npx claude-flow agent spawn -t docs-writer --name docs-1
npx claude-flow agent spawn -t devops-engineer --name devops-1
```

### Verificar métricas de agente

```bash
npx claude-flow agent metrics --name coder-1
```

---

## Memória

### Armazenar dados

```bash
npx claude-flow memory store \
  --key "swarm/coder/status" \
  --value '{"status":"working","task":"login"}' \
  --namespace coordination
```

### Buscar por chave

```bash
npx claude-flow memory retrieve \
  --key "swarm/coder/status" \
  --namespace coordination
```

### Busca semântica

```bash
npx claude-flow memory search \
  --query "progresso da implementação"
```

### Listar namespace

```bash
npx claude-flow memory list \
  --namespace patterns \
  --limit 10
```

### Inicializar memória

```bash
npx claude-flow memory init
```

---

## Swarm

### Inicializar swarm

```bash
# Básico
npx claude-flow swarm init

# Com opções
npx claude-flow swarm init \
  --topology hierarchical \
  --max-agents 10 \
  --strategy specialized \
  --v3-mode
```

### Status do swarm

```bash
npx claude-flow swarm status
```

### Monitorar swarm

```bash
npx claude-flow swarm monitor
```

---

## Tarefas (Tasks)

### Orquestrar tarefa

```bash
npx claude-flow task orchestrate \
  --objective "Implementar endpoint de login" \
  --workflow feature
```

### Status de tarefa

```bash
npx claude-flow task status --id task-123
```

### Resultados de tarefa

```bash
npx claude-flow task results --id task-123
```

---

## Diagnóstico

### Verificar saúde do sistema

```bash
npx claude-flow doctor
npx claude-flow doctor --fix  # Tenta corrigir problemas automaticamente
```

### Verificar status neural

```bash
npx claude-flow neural status
```

### Treinar padrões

```bash
npx claude-flow neural train
```

### Ver padrões aprendidos

```bash
npx claude-flow neural patterns
```

---

## Benchmarks

```bash
npx claude-flow benchmark run
```

---

## Detecção de Features

```bash
npx claude-flow features detect
```

---

## Referência Rápida

### Comandos mais usados no dia a dia

```bash
# 1. Inicializar tudo (primeira vez)
bash scripts/init-hive.sh

# 2. Ver status do hive
npx claude-flow hive-mind status

# 3. Spawnar agentes para trabalhar
npx claude-flow hive-mind spawn --claude -o "Meu objetivo aqui"

# 4. Ver agentes ativos
npx claude-flow agent list

# 5. Buscar na memória
npx claude-flow memory search --query "minha busca"

# 6. Diagnóstico
npx claude-flow doctor
```

### Fluxo típico de uso

```bash
# Passo 1: Inicializar (se necessário)
npx claude-flow hive-mind status  # Verificar se já está ativo

# Passo 2: Definir objetivo
npx claude-flow hive-mind spawn --claude -o "Implementar feature X"

# Passo 3: Acompanhar
npx claude-flow swarm status

# Passo 4: Ver resultados
npx claude-flow task results --id [task-id]
```
