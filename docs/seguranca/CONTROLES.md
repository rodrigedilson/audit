# Inventário de controles de segurança

> **Para quem é este documento:** quem vai conduzir a certificação ISO 27001 ou
> SOC 2, e quem precisa responder a um questionário de segurança de cliente.
>
> Ele não é um plano de conformidade. É o levantamento do que **existe hoje no
> código**, com onde verificar cada afirmação, e a lista do que **não existe**.
> Cada linha da primeira tabela pode ser conferida abrindo o arquivo citado; a
> segunda tabela é a que importa numa auditoria, porque é onde estão as
> respostas "não temos".

## Por que isto é pré-requisito comercial, e não zelo

O produto custodia **certificado A1 de terceiro**. Quem guarda o A1 de uma
empresa pode agir em nome dela perante o Fisco: emitir, consultar, manifestar,
transmitir. Isso muda a natureza da pergunta que um cliente faz antes de
contratar — deixa de ser "seus dados estão seguros?" e passa a ser "o que
impede alguém aí dentro de assinar em meu nome?".

ISO 27001 ou SOC 2 Type I é a forma de responder isso sem pedir confiança.

## O que existe

| Controle | Como está implementado | Onde verificar |
|---|---|---|
| Cifragem do A1 em repouso | AES-256-GCM, chave fora do banco, PFX nunca devolvido pela API — a coluna não é sequer selecionada na rota de leitura | [`certificate-vault.ts`](../../src/fiscal/portfolio/certificate-vault.ts), [`certificate.routes.ts`](../../src/api/routes/certificate.routes.ts) |
| Chave mestra em secret manager | Doppler, com log de acesso e rotação versionada. Removida do painel do provedor de hospedagem | [`SEGREDOS.md`](../setup/SEGREDOS.md) |
| Rotação de chave sem perda | Cofre aceita chave atual e anterior; cada linha guarda `key_id` derivado por HMAC | [`certificate-vault.ts`](../../src/fiscal/portfolio/certificate-vault.ts), [`recifrar-certificados.ts`](../../scripts/recifrar-certificados.ts) |
| Verificação da rotação | `npm run doctor` reporta quantos certificados estão fora da chave atual | [`environment-doctor.ts`](../../src/infrastructure/diagnostics/environment-doctor.ts) |
| Trilha de uso do A1 | Todo uso emite `certificate.used` com finalidade, serviço, resultado e IP, em log append-only | [`fiscal-vocabulary.ts`](../../src/fiscal/shared/fiscal-vocabulary.ts) |
| Autenticação | JWT verificado contra JWKS do Supabase (assimétrico). O papel vem de `memberships`, nunca de claim do token — claim fica velho quando o papel muda | [`jwt-verifier.ts`](../../src/api/auth/jwt-verifier.ts), [`tenant-resolver.ts`](../../src/api/auth/tenant-resolver.ts) |
| Autorização por papel | `owner`, `accountant`, `viewer`, aplicados na API. A tela esconde o que o papel não permite, mas quem autoriza é a rota | [`tenant-resolver.ts`](../../src/api/auth/tenant-resolver.ts) |
| Isolamento entre clientes | Toda consulta escopada por `(tenant_id, cnpj)`; RLS em 12 tabelas com 22 policies, como segunda tranca | [`20260918120000_multi_tenancy.sql`](../../supabase/migrations/20260918120000_multi_tenancy.sql) |
| Não repúdio | Event log append-only garantido por trigger no banco, não por convenção. Projeção com hash SHA-256 conferível por `POST /verify` | mesma migration, trigger `events_append_only` |
| Integridade do dado fiscal | Replay determinístico reproduz o hash; divergência é detectada, não silenciada | [`fiscal-hash-verifier.service.ts`](../../src/fiscal/projection/fiscal-hash-verifier.service.ts) |
| Vulnerabilidade em dependência | `npm audit --audit-level=high` falha o CI | [`ci.yml`](../../.github/workflows/ci.yml) |
| Segredo commitado | Gitleaks no histórico completo, em job próprio do CI (`fetch-depth: 0`), com três falsos positivos liberados um a um e justificados | [`ci.yml`](../../.github/workflows/ci.yml), [`.gitleaks.toml`](../../.gitleaks.toml) |
| Segredo em ambiente de teste | A suíte se recusa a rodar com `DATABASE_URL` apontando para outro banco | [`global-db.ts`](../../tests/setup/global-db.ts) |

### Fechados nesta rodada

| Controle | Onde se verifica |
|---|---|
| **Rate limit nas rotas autenticadas** | Por usuário do token, 240/min e 6.000/h, em hook global — rota nova nasce limitada. As públicas já tinham: login (5/min e 20/h), calculadora (30/min), `/plans` (60/min) e diagnóstico público (rajada + quota diária no banco). [`server.ts`](../../src/api/server.ts), [`rate-limit.ts`](../../src/api/plugins/rate-limit.ts) |
| **Lista de sub-processadores** | [`SUBPROCESSADORES.md`](SUBPROCESSADORES.md) |
| **Classificação de dados** | [`CLASSIFICACAO-DE-DADOS.md`](CLASSIFICACAO-DE-DADOS.md), cobrindo todos os 74 objetos de **produção** — não só os que as migrations criam |
| **Plano de resposta a incidente** | [`INCIDENTES.md`](INCIDENTES.md): cinco classes específicas deste sistema, cada uma com como detectar, o que fazer na primeira hora e o que preservar antes de corrigir. Traz o prazo da Resolução CD/ANPD nº 15/2024 — três dias úteis para a comunicação preliminar, contados do conhecimento do fato |
| **Trilha operacional de segurança** | `security_events` grava login, recusa por token, recusa por papel e limite — o que o event log não cobre, porque aquele é prova fiscal e este é investigação. Registro num ponto só, o tratador de erro, para rota nova não nascer sem trilha. Guarda HMAC de IP e de e-mail, nunca os valores. [`security-trail.ts`](../../src/infrastructure/security/security-trail.ts) |
| **Exposição à chave pública medida, e não presumida** | O doctor assume o papel `anon` e conta linhas, que é o que o PostgREST faz ao atender a chave. Conferir privilégio não serve: o Supabase concede `select` ao `anon` no schema inteiro e deixa a RLS barrar, então `has_table_privilege` acusaria 69 objetos onde há 6. [`environment-doctor.ts`](../../src/infrastructure/diagnostics/environment-doctor.ts) |

> O limitador é **em memória e por processo**, como o das rotas públicas. Com
> mais de uma instância, cada uma conta a sua parte e o limite efetivo multiplica
> pelo número de instâncias. Hoje roda uma instância; passar de uma exige mover a
> contagem para o banco ou para um Redis, e isso continua aberto.

## O que não existe

Esta é a tabela que uma auditoria vai usar. Nenhum item aqui está mitigado por
outro controle; estão abertos.

| Lacuna | Consequência | Esforço |
|---|---|---|
| **Backup com restauração testada** | O Supabase faz backup; **ninguém nunca restaurou**. Backup não testado é hipótese, não controle. É a lacuna mais séria da lista. A ferramenta de conferência já existe ([`conferir-restauracao.ts`](../../scripts/conferir-restauracao.ts), procedimento abaixo); falta executar o ensaio contra um backup de verdade | 1–2h |

| **Dado legado fora do modelo de isolamento** | Vinte e dois objetos sobraram da fase anterior do produto, dezoito com dado de clientes reais (notas, itens, tributos, XML). Nenhuma migration os cria e nenhum código os lê, então estão fora do isolamento por `(tenant_id, cnpj)` e de qualquer trilha. Um deles — a view `sped_invoices_for_crossref` — servia 192 notas à chave pública, e isso foi fechado; o acervo continua lá. Migrar, arquivar ou apagar é decisão de negócio, não técnica. Inventariado em [`CLASSIFICACAO-DE-DADOS.md`](CLASSIFICACAO-DE-DADOS.md) | 4h + decisão |
| **Revisão de acesso** | Não há registro de quem tem acesso a Doppler, Supabase, Render e GitHub, nem revisão periódica. `GET /v1/users` lista o acesso ao produto, não à infraestrutura | 2h + recorrência |
| **MFA obrigatório nos consoles** | Não verificado nem exigido nos provedores. O procedimento de conferência está abaixo; **ligar o MFA é ação humana em cada console**, e nenhum código aqui alcança isso | 1h |
| **Retenção e descarte** | Sem política de retenção nem procedimento de exclusão a pedido do titular. O event log é append-only **por projeto**, o que torna "apagar dado pessoal" uma questão de arquitetura e não de rotina — precisa de decisão antes de virar procedimento | 8h + decisão |



| **Log centralizado e retenção** | A metade que importa saiu do provedor: autenticação, autorização e limite agora ficam em `security_events`, no banco, com HMAC de IP e de e-mail. Falta o resto — log de aplicação ainda vive no provedor com retenção curta, e não há política de expurgo da trilha nem alerta sobre ela | 4h |

## O que a certificação vai perguntar e a resposta é boa

Vale saber onde o projeto está forte, porque são os pontos que sustentam o
resto:

- **Rastreabilidade do que o sistema afirma.** Cada número fiscal tem evento de
  origem e hash verificável. Isso é incomum e responde sozinho a boa parte dos
  controles de integridade.
- **Ausência de verificação é declarada.** O sistema distingue "conferi e está
  certo" de "não conferi" em quatro módulos, e a tela não colapsa os dois. Numa
  auditoria isso aparece como maturidade de controle, não como funcionalidade.
- **O PFX nunca sai.** Não existe rota de download; a ausência é o controle.

## Ensaio de restauração

O procedimento existe para que a lacuna se feche com **evidência**, e não com a
afirmação de que alguém restaurou uma vez. Quem repetir isto daqui a um ano tem
de chegar ao mesmo resultado sem perguntar nada a ninguém.

A conferência aproveita o que este produto tem de incomum: o log é append-only e
a sequência é densa por `(tenant_id, cnpj)`. Um log restaurado ou é **idêntico**
ao de origem, evento por evento, ou está errado — não há meio-termo a
interpretar, e por isso o resultado é binário.

1. No painel do Supabase, restaure o backup mais recente **num projeto novo**.
   Nunca por cima do de produção: se a restauração vier ruim, o ensaio teria
   destruído o que ele existe para proteger.

2. Pegue a string de conexão do projeto restaurado e rode:

   ```bash
   ORIGEM_DATABASE_URL="$(doppler secrets get DATABASE_URL --plain --project audit --config prd)"    RESTAURADO_DATABASE_URL='postgresql://…projeto-restaurado…'      npx tsx scripts/conferir-restauracao.ts
   ```

   As duas conexões abrem em transação somente-leitura. O script recusa rodar
   com as duas URLs iguais e recusa passar sobre um banco sem eventos — nos dois
   casos ele "passaria" sem ter comparado nada, que é pior do que falhar.

3. Guarde a saída com a data. Uma auditoria pede a evidência, não a lembrança.

4. Apague o projeto restaurado.

O que é conferido, e por quê:

| Conferência | O que pega |
|---|---|
| Gatilho `events_append_only` e índice único de `event_id` | Restauração que perdeu o gatilho aceita `update` no log, e o banco deixa de ser trilha de defesa **sem nenhum sintoma visível** |
| Digest SHA-256 do fluxo de eventos, por escopo | Alteração de conteúdo ou de ordem que a contagem não vê. A mensagem distingue "a contagem bate e o conteúdo não — é alteração, não perda" de perda de evento |
| Hash de projeção, por escopo | O mesmo hash que o cliente vê na tela e que `POST /verify` recalcula |

A ferramenta foi exercitada contra uma cópia real de 86.312 eventos em 27.860
escopos: a cópia fiel passa, e as três adulterações testadas — gatilho removido,
um `payload` alterado e um evento apagado — foram todas acusadas, cada uma com
sua mensagem.

## Conferência de MFA nos consoles

Quem tem acesso a qualquer um destes quatro consoles alcança o acervo inteiro,
por caminhos diferentes. Sem MFA, a proteção de tudo isso é uma senha.

| Console | O que o acesso alcança | Onde se liga |
|---|---|---|
| **Doppler** | A chave mestra do cofre. Com ela, todo PFX guardado é decifrável | *Settings → Multi-Factor Authentication* |
| **Supabase** | O banco inteiro, e a emissão de token de qualquer usuário | *Account → Security → Two-Factor Authentication* |
| **Render** | As variáveis do serviço e o deploy — quem faz deploy roda código com os segredos | *Account Settings → Two-Factor Authentication* |
| **GitHub** | O código e, por consequência, o que vai a produção | *Settings → Password and authentication → Two-factor authentication* |

Para cada um, registre **a data da conferência e o método** (aplicativo TOTP ou
chave física; SMS não conta — é vulnerável a troca de chip). Guarde junto a lista
de quem tem acesso, que é a lacuna de revisão de acesso, logo abaixo nesta mesma
tabela: as duas se conferem na mesma sentada e uma sem a outra vale pouco.

Nada no código alcança isto, e por isso não há checagem no `npm run doctor`: o
MFA vive na conta de cada provedor. Uma checagem que dissesse "ok" sem ter
verificado seria pior que a lacuna, que ao menos é honesta.

## Ordem sugerida

1. **Backup restaurado**, porque é o único item cuja falha é irreversível. A
   ferramenta existe; falta o ensaio.
2. **MFA nos consoles**, que é uma hora de trabalho humano e protege tudo o mais.
3. **Revisão de acesso**, que se faz na mesma sentada do MFA.
4. **Resposta a incidente**, que é o que uma auditoria pergunta depois de ver o
   resto pronto.

Sub-processadores, classificação de dados e rate limit saíram desta lista e estão
em "o que existe".
4. **Retenção e descarte**, que precisa de decisão de produto antes de virar
   procedimento — e a decisão é como conciliar LGPD com event log append-only.
5. **Resposta a incidente** e **revisão de acesso**, que são processo e só
   valem depois que houver o que revisar.
