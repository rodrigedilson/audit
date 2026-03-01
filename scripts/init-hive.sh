#!/bin/bash
# Inicialização do Hive Mind para Engenharia de Software
# Uso: bash scripts/init-hive.sh

set -e

echo "=== Inicializando Hive Mind - Software Engineering ==="

# Inicializar memória
echo "[1/4] Inicializando banco de memória..."
npx claude-flow memory init 2>/dev/null || echo "Memória já inicializada"

# Inicializar hive-mind com topologia hierárquica-mesh
echo "[2/4] Inicializando Hive Mind (hierarchical-mesh)..."
npx claude-flow hive-mind init -t hierarchical-mesh 2>/dev/null || echo "Hive Mind já inicializado"

# Inicializar swarm
echo "[3/4] Inicializando Swarm..."
npx claude-flow swarm init --topology hierarchical --max-agents 10 --strategy specialized 2>/dev/null || echo "Swarm já inicializado"

# Status
echo "[4/4] Verificando status..."
npx claude-flow hive-mind status 2>/dev/null || echo "Status: Hive Mind configurado"

echo ""
echo "=== Hive Mind pronto! ==="
echo ""
echo "Agentes disponíveis:"
echo "  - tech-lead (Queen/Coordenador)"
echo "  - architect (Design de sistema)"
echo "  - coder (Implementação)"
echo "  - debugger (Investigação de bugs)"
echo "  - tester (Testes e validação)"
echo "  - reviewer (Revisão de código)"
echo "  - security-engineer (Segurança)"
echo "  - performance-engineer (Performance)"
echo "  - docs-writer (Documentação)"
echo "  - devops-engineer (Infraestrutura)"
echo ""
echo "Workflows:"
echo "  - feature: Design → Código → Teste → Review"
echo "  - bugfix: Investigação → Fix → Teste de regressão"
echo "  - security_audit: Threat model → Scan → Remediação"
echo "  - performance_optimization: Profile → Análise → Otimização → Benchmark"
