# ADR-003 — Event store em Postgres com sequência por CNPJ

- **Status:** Aceita
- **Data:** 2026-09-18

## Contexto

Três problemas do event store JSONL impedem uso em SaaS fiscal:

1. **Sequência global.** `event_seq` era monotônico global. Em multi-tenant, dois
   escritórios disputariam a mesma sequência.
2. **Corrida na escrita.** `EventAppenderService.append()` fazia
   `getLastSeq()` → `+1` → `appendFile`, sem atomicidade. INV-004 (sequência sem
   gaps) era frágil por construção.
3. **INV-005 (single-writer) não existia.** Nem global, nem por entidade. Havia
   apenas a string `'lock_violation'` no enum de rejeições, sem nenhum produtor.
   O YAML declarava "lock file mechanism" e não havia lock file algum.

Além disso o custo era O(n) em tudo: cada leitura relia e reparseava o arquivo
inteiro, e cada `processIntention` fazia isso ~3 vezes, re-projetando desde o
evento 0. O briefing prevê milhares de XML por escritório por mês.

## Decisão

1. `PostgresEventStoreRepository` implementando a porta existente
   `IEventStoreRepository` (6 métodos), **escopado por `(tenant_id, cnpj)`**.
   `JsonlEventStoreRepository` permanece como adapter de teste e dev.
2. `event_seq` é monotônico **por `(tenant_id, cnpj)`** — nunca global.
3. **Chave única `(tenant_id, cnpj, event_seq)`** e `event_id` único global. A
   constraint faz a corrida falhar alto em vez de corromper silenciosamente; isso
   também passa a cumprir a parte de unicidade de `event_id` do INV-004, que nunca
   era verificada.
4. **INV-005 vira `pg_advisory_xact_lock(hashtextextended(tenant_id || ':' || cnpj, 0))`**
   dentro da transação do append. Isto é: **single writer por CNPJ**, como o briefing
   pede ("uma fila de escrita por CNPJ"), não global — dois CNPJs do mesmo escritório
   devem poder fechar em paralelo.
5. Tabela `projection_snapshots` para eliminar o replay integral a cada intenção.
6. Particionar `events` por `tenant_id`.

## Consequências

- O replay determinístico (INV-006) continua possível e passa a ser por CNPJ, o que
  é exatamente o que o produto precisa: "reprocessar a carteira inteira quando uma
  regra muda de vigência".
- Snapshots introduzem um cache que pode divergir do log. Mitigação: o snapshot
  guarda `last_event_seq` + hash, e `POST /verify` sempre reprojeta do zero.
