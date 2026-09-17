# 07 - Uso Prático e Exemplos

Guia prático com exemplos reais de como usar o Hive Mind no dia a dia de desenvolvimento.

---

## Exemplo 1: Implementar uma Nova Feature

### Cenário

Você precisa implementar um sistema de notificações por email com templates customizáveis.

### Passo 1: Pedir ao Claude Code

```
"Implemente um sistema de notificações por email com templates customizáveis"
```

### O que acontece internamente

```
1. Tech Lead recebe o pedido e decompõe:

   Subtarefa 1 (architect):
     "Desenhar arquitetura do módulo de notificações"
     - Definir interfaces
     - Escolher biblioteca de email
     - Definir modelo de templates

   Subtarefa 2 (coder):
     "Implementar serviço de email"
     - Criar EmailService
     - Implementar TemplateEngine
     - Criar endpoints de API

   Subtarefa 3 (tester):
     "Testar módulo de notificações"
     - Testes unitários do EmailService
     - Testes de integração com mock SMTP
     - Testes de edge cases (template inválido, email inválido)

   Subtarefa 4 (reviewer):
     "Revisar implementação"
     - Verificar segurança (XSS em templates?)
     - Verificar performance (envio assíncrono?)
     - Verificar qualidade de código

2. Architect produz especificação:
   - Interface EmailService
   - Interface TemplateEngine
   - Modelo de dados para templates
   - ADR sobre escolha de biblioteca

3. Coder implementa seguindo spec:
   src/notifications/
     email.service.ts
     template.engine.ts
     notification.controller.ts
     types.ts

4. Tester cria suíte de testes:
   tests/notifications/
     email.service.test.ts
     template.engine.test.ts
     notification.controller.test.ts

5. Reviewer aprova ou pede correções
```

---

## Exemplo 2: Corrigir um Bug

### Cenário

O endpoint de listagem de usuários está retornando dados duplicados quando há paginação.

### Passo 1: Pedir ao Claude Code

```
"O endpoint GET /users retorna usuários duplicados na segunda página. Investigar e corrigir."
```

### O que acontece internamente

```
1. Tech Lead identifica: workflow de bugfix

2. Debugger investiga:

   OBSERVAR:
   - GET /users?page=1 -> retorna users 1-20 (OK)
   - GET /users?page=2 -> retorna users 18-37 (DUPLICADOS: 18, 19, 20!)

   HIPÓTESES:
   H1: Offset calculado errado -> TESTAR
   H2: Dados inseridos entre requests -> DESCARTAR (reproduz em DB readonly)
   H3: Cache retornando dados stale -> DESCARTAR (sem cache neste endpoint)

   TESTAR H1:
   - Query gerada: SELECT * FROM users ORDER BY id LIMIT 20 OFFSET 17
   - Esperado: OFFSET 20 (page 2 = (2-1) * 20 = 20)
   - Real: OFFSET 17 (bug!)

   CAUSA RAIZ:
   - Cálculo do offset: (page - 1) * pageSize - 3
   - O "- 3" foi introduzido no commit abc123 como "overlap fix"

   FIX SUGERIDO:
   - Remover o "- 3" do cálculo de offset

3. Coder aplica fix:
   - Linha 42: offset = (page - 1) * pageSize
   - Remover "overlap fix" incorreto

4. Tester cria regressão:
   - Teste: página 1 não repete na página 2
   - Teste: última página não repete na penúltima
   - Teste: página 1 com 0 resultados retorna array vazio
   - Todos os 67 testes existentes: PASSANDO
```

---

## Exemplo 3: Auditoria de Segurança

### Cenário

Antes de lançar em produção, você quer garantir que o módulo de autenticação está seguro.

### Passo 1: Pedir ao Claude Code

```
"Faça uma auditoria de segurança completa no módulo de autenticação"
```

### O que acontece internamente

```
1. Tech Lead identifica: workflow de security_audit

2. Security Engineer - Threat Model (STRIDE):

   SPOOFING:
   [HIGH] Tokens JWT não são invalidados no logout
   - Mitigação: implementar blacklist de tokens

   TAMPERING:
   [MEDIUM] Payload do JWT não é assinado com algoritmo forte
   - Mitigação: trocar HS256 por RS256

   INFORMATION DISCLOSURE:
   [CRITICAL] Password hash visível na resposta de GET /users/:id
   - Mitigação: excluir campo passwordHash do select

   ELEVATION OF PRIVILEGE:
   [HIGH] Endpoint /admin não verifica role do usuário
   - Mitigação: adicionar middleware de autorização

3. Security Engineer - Scan:
   - OWASP A01 (Broken Access Control): 1 issue
   - OWASP A02 (Cryptographic Failures): 1 issue
   - Dependências: 0 vulnerabilidades
   - Secrets: 0 hardcoded

4. Coder remedia (por prioridade):
   1. [CRITICAL] Excluir passwordHash dos selects
   2. [HIGH] Implementar blacklist de tokens no Redis
   3. [HIGH] Adicionar middleware checkRole('admin')
   4. [MEDIUM] Migrar de HS256 para RS256
```

---

## Exemplo 4: Otimização de Performance

### Cenário

O dashboard está demorando 8 segundos para carregar.

### Passo 1: Pedir ao Claude Code

```
"O dashboard demora 8s para carregar. Otimizar para menos de 2s."
```

### O que acontece internamente

```
1. Tech Lead identifica: workflow de performance_optimization

2. Performance Engineer - Profiling:

   Endpoint: GET /dashboard
   Response time: 8200ms (p95)
   Breakdown:
   - DB queries: 6500ms (79%)
   - Business logic: 1200ms (15%)
   - Serialization: 500ms (6%)

   DB queries detalhadas:
   - Query 1: SELECT all orders (3200ms) - retorna 50k rows
   - Query 2: SELECT all products (2100ms) - retorna 10k rows
   - Query 3: Aggregate calcs (1200ms) - full table scan

3. Performance Engineer - Análise:

   [CRITICAL] Query 1: Carrega TODOS os orders sem filtro
   -> Solução: filtrar por período (últimos 30 dias) + paginação

   [CRITICAL] Query 2: Carrega TODOS os produtos
   -> Solução: carregar apenas top 10 produtos vendidos

   [HIGH] Query 3: Full table scan
   -> Solução: criar índice em orders(created_at, product_id)

   [MEDIUM] Sem cache
   -> Solução: Redis cache com TTL de 5 minutos

4. Coder otimiza:
   - Query 1: WHERE created_at > now() - interval '30 days'
   - Query 2: ORDER BY sales DESC LIMIT 10
   - Query 3: CREATE INDEX idx_orders_date_product
   - Cache: Redis TTL 300s para dashboard

5. Tester - Benchmark:

   | Métrica | Antes | Depois | Ganho |
   |---------|-------|--------|-------|
   | Response (p95) | 8200ms | 180ms | 45x |
   | DB queries | 3 (6.5s) | 3 (35ms) | 185x |
   | Memory | 450MB | 28MB | 16x |
   | Rows processadas | 60k | 40 | 1500x |

   Meta de < 2s: ATINGIDA (180ms)
```

---

## Exemplo 5: Usando via Slash Commands (GSD)

### Planejamento de Phase

```
/gsd:plan-phase
```

Isso inicia o planejamento GSD, que:
1. Define O QUE construir (tarefas e subtarefas)
2. O Hive Mind coordena QUEM constrói
3. Os agentes executam COMO construir

### Execução de Phase

```
/gsd:execute-phase
```

Dispara a execução coordenada pelo hive mind:
1. Tech Lead decompõe as tarefas da phase
2. Agentes são spawnados conforme workflow
3. Trabalho é executado em paralelo quando possível
4. Reviewer valida qualidade ao final

### Verificação

```
/gsd:verify-work
```

Ativa reviewer + tester para validar o resultado.

---

## Dicas de Uso

### 1. Seja específico no pedido

```
# Ruim
"Melhore o código"

# Bom
"O endpoint GET /orders está demorando 5s. Otimize para menos de 500ms."
```

### 2. Deixe a queen decompor

Não tente microgerenciar os agentes. O tech-lead sabe como distribuir o trabalho.

```
# Ruim
"Coder: faça X. Tester: faça Y. Architect: faça Z."

# Bom
"Implemente autenticação JWT com refresh tokens."
```

### 3. Confie no workflow

O hive mind tem workflows predefinidos. Não precisa especificar a sequência de agentes.

```
# Ruim
"Primeiro o architect desenha, depois o coder implementa, depois o tester testa..."

# Bom
"Implemente feature X"  (o workflow 'feature' cuida da sequência)
```

### 4. Use agentes on-demand quando necessário

Se precisa especificamente de segurança ou performance, mencione:

```
"Implemente feature X e faça uma auditoria de segurança"
"O endpoint Y está lento, otimize"
```

### 5. Não cheque status repetidamente

Depois de spawnar agentes, espere os resultados. Os agentes reportam via memória compartilhada.

```
# Ruim (polling)
npx claude-flow agent list    # 10 segundos depois
npx claude-flow swarm status  # 20 segundos depois
npx claude-flow agent list    # 30 segundos depois

# Bom (espera)
npx claude-flow hive-mind spawn --claude -o "Objetivo"
# ... espera os resultados ...
npx claude-flow task results --id [task-id]
```

---

## Troubleshooting

### "Nenhum agente ativo"

```bash
# Verificar se o hive mind está inicializado
npx claude-flow hive-mind status

# Se não estiver, inicializar
bash scripts/init-hive.sh
```

### "Memória não encontrada"

```bash
# Reinicializar memória
npx claude-flow memory init

# Verificar saúde
npx claude-flow doctor --fix
```

### "Agente não responde"

```bash
# Verificar agentes ativos
npx claude-flow agent list

# Verificar métricas
npx claude-flow agent metrics --name [nome-do-agente]

# Respawnar se necessário
npx claude-flow agent spawn -t [tipo] --name [nome]
```

### "Drift detectado"

```bash
# O anti-drift automaticamente notifica a queen
# Verifique o drift score
npx claude-flow hive-mind status

# Se drift > 0.3, a queen realinha automaticamente
# Se persistir, reinicialize
npx claude-flow hive-mind init -t hierarchical-mesh
```
