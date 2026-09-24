# Architecture Decision Records

Decisões arquiteturais do produto `audit` (SaaS fiscal). Uma decisão por arquivo,
numeração sequencial, nunca reescrita — decisão superada recebe status
`Substituída por ADR-XXX`.

> Os ADRs numerados citados em `.claude/` e no `CLAUDE.md` (ADR-001 a ADR-010,
> ADR-026, ADR-048+) pertencem ao **claude-flow v3**, um produto de terceiro, e não
> a este projeto. A numeração abaixo é independente e começa em ADR-001.

| ADR | Título | Status |
|---|---|---|
| [ADR-001](ADR-001-supabase-como-plataforma.md) | Supabase como plataforma de dados, auth e storage | Aceita |
| [ADR-002](ADR-002-multi-tenancy-e-isolamento.md) | Multi-tenancy: escopo por tenant e CNPJ | Aceita |
| [ADR-003](ADR-003-event-store-postgres.md) | Event store em Postgres com sequência por CNPJ | Aceita |
| [ADR-004](ADR-004-cobranca-asaas.md) | Asaas como provedor de cobrança | Aceita |
| [ADR-005](ADR-005-canonicalizacao-do-hash.md) | Canonicalização JSON determinística para o hash de projeção | Aceita |
| [ADR-006](ADR-006-coleta-dfe-sefaz.md) | Coleta de DF-e na SEFAZ: distribuição por NSU e ciência da operação | Aceita |
| [ADR-007](ADR-007-uso-nao-assistido-do-certificado.md) | Uso não assistido do certificado A1 | Proposta |
