# ADR-001 — Supabase como plataforma de dados, auth e storage

- **Status:** Aceita
- **Data:** 2026-09-18
- **Contexto da decisão:** Onda 1 do plano de adaptação para SaaS fiscal

## Contexto

O kernel ESAA-Flow era single-user e file-based (`JsonlEventStoreRepository` sobre
`.roadmap/activity.jsonl`). Para virar SaaS multi-tenant faltava tudo: banco,
autenticação, convites de usuário, storage de XML/PDF e cifragem em repouso.
Nenhuma dessas peças existia no repositório — a decisão estava completamente aberta.

## Decisão

Adotar **Supabase** como plataforma: Postgres gerenciado, Supabase Auth para
identidade, RLS para isolamento em profundidade e Storage para XMLs, PFX cifrados e
PDFs de Book.

**Consequência arquitetural que não é negociável:** o frontend fala **somente** com
a nossa API (Fastify), nunca com `supabase-js` para dados fiscais. O RLS é a
*segunda* tranca — proteção caso uma chave anon vaze — e não o mecanismo primário de
autorização. O motivo: toda escrita fiscal precisa passar pelo orquestrador
single-writer e pelo pipeline de 7 camadas, e um `INSERT` direto do cliente burlaria
as duas coisas, gerando um log sem trilha de validação.

## Alternativas consideradas

- **Fastify + Postgres + Drizzle + JWT próprio:** mais portátil e sem vendor
  lock-in, mas exigia implementar auth, convites e recuperação de senha do zero.
- **NestJS + Prisma:** mais convenção e DI nativo, porém Prisma é rígido para o SQL
  de event sourcing (particionamento, advisory locks, `INSERT ... SELECT max+1`).

## Consequências

- Ganhamos auth, convites e storage prontos; o time-to-market da Onda 2 cai.
- Aceitamos acoplamento ao fornecedor. Mitigação: o kernel continua falando com a
  porta `IEventStoreRepository`, então trocar Supabase por Postgres puro é trocar um
  adapter e a verificação de JWT.
- A cifragem do PFX do certificado A1 continua sendo **responsabilidade da nossa
  aplicação** (AES-256-GCM, chave mestra em secret manager). Supabase Storage dá o
  bucket privado, não a cifragem de campo.
