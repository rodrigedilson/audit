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

## Revisão na implementação (2026-09-18)

**A "camada 0" do pipeline não foi criada, e o motivo é estrutural.** Esta ADR
previa uma camada de isolamento antes do parse, respondendo "o actor pertence a
este tenant? o CNPJ pertence a este tenant?".

Ao implementar ficou claro que uma camada do pipeline não consegue responder
isso melhor do que quem a chama. A `ESAAIntention` deliberadamente **não** carrega
tenant nem CNPJ — se carregasse, um cliente poderia pedir escrita no log de outro
escritório. O escopo vem do orquestrador, montado pela API. Uma camada de
validação dentro do pipeline receberia exatamente o mesmo escopo, possivelmente
errado, e o confirmaria contra si mesmo: uma tautologia, não uma verificação.

O isolamento passou a ser garantido em quatro pontos reais, todos com teste:

1. **`TenantResolver` na fronteira HTTP** — resolve o escritório em `memberships`
   (nunca de um claim do token, que fica velho quando o usuário sai) e prova que
   o CNPJ da rota pertence àquele tenant antes de montar o `EventScope`.
2. **`EventScope` + repositório escopado** — a instância do store *é* o par
   (tenant, CNPJ); não existe consulta sem escopo para esquecer de filtrar.
3. **`assertInScope` no appender e no adapter Postgres** — evento de escopo alheio
   é rejeitado em vez de silenciosamente reescrito para o log atual.
4. **RLS** como segunda tranca.

O motivo de rejeição `tenant_violation` foi adicionado ao vocabulário e é
produzido na fronteira HTTP.

**Detalhe de resposta que vale registrar:** um CNPJ que existe em *outro*
escritório responde **404, não 403**. Um 403 confirmaria ao chamador que aquele
CNPJ está cadastrado na plataforma, e a carteira de um escritório é informação
comercial sensível diante de um concorrente. Há teste exigindo que as respostas
de "não existe" e "existe, mas não é seu" sejam indistinguíveis.
