# ADR-002 — Multi-tenancy: escopo por tenant e CNPJ

- **Status:** Aceita
- **Data:** 2026-09-18

## Contexto

O kernel não tinha nenhuma noção de tenant, usuário ou empresa. A única identidade
era `actor: string` = nome de agente de IA, validado contra uma whitelist global
hardcoded de 10 agentes de engenharia (`AGENT_TO_TASK_KIND`). Identidade de máquina,
não de organização.

O event log estava **vazio** (`.roadmap/activity.jsonl` nunca foi gerado), o que
permitiu introduzir o escopo de tenant no envelope do evento sem migração de dados.

## Decisão

1. `tenant_id`, `cnpj` e `period` passam a ser campos de **primeira classe** do
   envelope `ESAAEventData`, não payload.
2. A hierarquia é **escritório (tenant) → usuários → CNPJs (clients)**. Papéis:
   `owner`, `accountant`, `viewer`.
3. `actor` deixa de ser só nome de agente e ganha `actor_type: user | agent | orchestrator`.
4. Uma **nova camada de validação de isolamento** entra no pipeline **antes** do
   parse (camada 0): o actor pertence a este tenant? o CNPJ pertence a este tenant?
   Novo motivo de rejeição `tenant_violation`.
5. RLS em toda tabela com `tenant_id`.

## Por que a camada de isolamento vem antes do parse

Uma intenção de tenant errado não deve nem ser interpretada. Colocá-la depois do
schema (camada 2) significaria gastar parse e validação em dados que não deveriam
ser lidos, e — pior — arriscar mensagens de erro que revelem existência de recursos
de outro tenant.

## Consequências

- `ESAAOrchestratorService.currentRoadmap`, hoje um cache single-tenant por
  instância, precisa virar registry por `(tenant, cnpj)` ou uma instância por
  requisição.
- `ContractLoaderService` passa a carregar contratos por tenant, não um YAML global
  de disco lido apenas nos testes.
- O schema do evento (`.roadmap/schemas/event.schema.json`) tem
  `additionalProperties: false`, então os três campos novos precisam entrar em
  `required` no mesmo commit, senão todo evento passa a ser inválido.
