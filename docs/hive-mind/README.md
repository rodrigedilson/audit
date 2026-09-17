# Hive Mind - Documentação Completa

> Sistema de coordenação multi-agente para engenharia de software, baseado em **claude-flow v3.5.2** com topologia **hierarchical-mesh**.

---

## Índice Geral

| # | Documento | Descrição |
|---|-----------|-----------|
| 01 | [Conceitos Fundamentais](01-conceitos.md) | O que é o Hive Mind, terminologia, como funciona |
| 02 | [Arquitetura e Topologia](02-arquitetura.md) | Hierarchical-mesh, Raft consensus, anti-drift |
| 03 | [Agentes](03-agentes.md) | Todos os 10 agentes, suas funções, capacidades e prioridades |
| 04 | [Workflows](04-workflows.md) | Fluxos de trabalho: feature, bugfix, security, performance |
| 05 | [Memória e Coordenação](05-memoria.md) | Sistema de memória compartilhada, sincronização, HNSW |
| 06 | [Comandos CLI](06-comandos.md) | Todos os comandos do claude-flow para operar o Hive Mind |
| 07 | [Uso Prático e Exemplos](07-uso-pratico.md) | Exemplos reais de como usar no dia a dia |

---

## Visão Geral Rápida

### O que é?

O Hive Mind é um sistema de **orquestração de agentes de IA** que coordena múltiplos agentes especializados para realizar tarefas de engenharia de software. Funciona como uma colmeia: uma **Queen** (tech-lead) coordena **Workers** especializados (architect, coder, tester, etc.).

### Como funciona?

```
Você faz um pedido
       |
       v
  Queen (tech-lead)
  Decompõe a tarefa
       |
       v
+------+------+------+------+
|      |      |      |      |
v      v      v      v      v
Arch  Coder  Test  Sec   Perf
       |
       v
  Reviewer (quality gate)
       |
       v
  DevOps (deploy)
```

### Stack Tecnológico

| Componente | Tecnologia | Versão |
|------------|------------|--------|
| Orquestrador | claude-flow | 3.5.2 |
| Topologia | hierarchical-mesh | - |
| Consenso | Raft | - |
| Memória | Hybrid (HNSW + Graph) | - |
| Modelo Padrão | claude-opus-4-6 | - |
| Roteamento | claude-haiku-4-5 | - |

### Início Rápido

```bash
# 1. Inicializar o hive mind
bash scripts/init-hive.sh

# 2. Verificar status
npx claude-flow hive-mind status

# 3. Spawnar agentes
npx claude-flow hive-mind spawn -n 8

# 4. Executar um workflow
npx claude-flow hive-mind spawn --claude -o "Implementar feature X"
```

---

## Configuração do Projeto

### Arquivos Principais

| Arquivo | Função |
|---------|--------|
| `.claude-flow/hive-mind.yaml` | Configuração da topologia, workers e workflows |
| `.claude/settings.json` | Configuração geral, hooks, permissões e agentes |
| `.claude/agents/software-engineering/*.md` | Definições dos agentes especializados |
| `scripts/init-hive.sh` | Script de inicialização do hive mind |
| `CLAUDE.md` | Regras gerais do projeto e coordenação |

### Limites e Capacidades

| Parâmetro | Valor |
|-----------|-------|
| Máx Agentes Simultâneos | 15 |
| Checkpoint Anti-Drift | 5 minutos |
| Sync de Memória | 30 segundos |
| Máx Drift Score | 0.3 |
| Namespace Compartilhado | `software-engineering` |
