# ADR-005 — Canonicalização JSON determinística para o hash de projeção

- **Status:** Aceita
- **Data:** 2026-09-18
- **Corrige:** INV-006

## Contexto

A tese de venda do produto é que "o hash prova que o número deriva daqueles
documentos" — a trilha de defesa contra a apuração assistida. O `projection_hash_sha256`
é impresso no rodapé do Book de fechamento e exigido no `POST /confirm`.

A implementação original em `src/esaa/shared/infrastructure/crypto-utils.ts` era:

```ts
export function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}
```

O segundo argumento do `JSON.stringify`, **quando é um array, é um allowlist de
chaves aplicado recursivamente em todos os níveis** — não um ordenador. Como só as
chaves de topo entravam na lista, todo objeto aninhado era serializado vazio. A
saída canônica real era:

```json
{"issues":[{}],"last_event_seq":3,"last_updated":"…","run":{},
 "schema_version":"0.4.0","stats":{},"tasks":{}}
```

Consequência verificada empiricamente: alterar `tasks['T-1'].state` de `done` para
`todo` e zerar `stats.done` produzia **hash idêntico**. O hash só era sensível a
`schema_version`, `last_event_seq` e `last_updated`.

O teste existente passava porque adulterava o próprio campo de hash, não os dados.

## Decisão

Implementar canonicalização JSON **recursiva e determinística**, no espírito do
JCS (RFC 8785):

- chaves de objeto ordenadas lexicograficamente **em todos os níveis**;
- arrays preservam ordem (é significativa);
- `undefined` em objeto é omitido; em array vira `null` (como o `JSON.stringify`);
- sem espaços;
- ciclos são detectados e rejeitados com erro explícito, em vez de estourar a pilha.

Nenhuma dependência nova: são ~30 linhas e o projeto já é estrito em TypeScript.

## Consequências

- **Todo hash gravado antes desta correção é inválido.** Isso não gera migração
  porque o event log estava vazio (`.roadmap/activity.jsonl` nunca foi gerado).
- `HashVerifierService` passa a detectar adulteração de conteúdo de verdade, e por
  isso a divergência de hash pós-append deixa de ser `logger.error` e passa a
  **rejeitar** a intenção (ver `ESAAOrchestratorService`).
- Teste de regressão obrigatório: adulterar `tasks`, `stats`, `run` e `issues`
  **deve** alterar o hash. Sem esse teste, a regressão é silenciosa e invalida o
  produto inteiro.
