# Preparar o ambiente — Supabase + API

Passo a passo para sair de um projeto Supabase vazio até a API respondendo com
dados reais. Leva uns 15 minutos.

Ao final você terá: o schema aplicado, um escritório com seu usuário como
`owner`, a API no ar e um CNPJ com uma nota fiscal ingerida e trilha verificável.

**Pré-requisitos:** Node 22, um projeto Supabase criado, e acesso ao painel.

---

## 1. Crie seu usuário no Supabase

**Authentication → Users → Add user → Create new user.**

Preencha e-mail e senha, e marque **Auto Confirm User**.

> Marcar isso não é opcional. O projeto está com `mailer_autoconfirm: false`, e
> um usuário criado sem auto-confirmação fica pendente — o login devolve
> `invalid_credentials` mesmo com a senha certa, o que é difícil de diagnosticar.

---

## 2. Aplique o schema no SQL Editor

Os arquivos estão em [`scripts/sql/migracoes/`](../../scripts/sql/migracoes/) e são
**gerados** a partir de `supabase/migrations/` — os mesmos que a suíte de testes
exercita. Nunca edite os arquivos gerados; altere a migration de origem e rode
`npm run sql:bundle`.

No painel: **SQL Editor → New query**. Cole e execute **um arquivo por vez, na
ordem**. Cada um depende das tabelas do anterior.

| # | Arquivo | O que cria |
|---|---|---|
| 1 | `01-multi-tenancy.sql` | escritórios, usuários, CNPJs, competências e o event log; `append_event()` e o trigger append-only |
| 2 | `02-cofre-certificados.sql` | cofre dos certificados A1 |
| 3 | `03-cobranca.sql` | planos, assinatura, faturas; `billable_clients()` |
| 4 | `04-ingestao.sql` | documentos fiscais e seus itens |
| 5 | `05-catalogo-de-itens.sql` | catálogo com classificação por vigência, tabelas de códigos oficiais, `item_propagation()` |
| 6 | `06-apuracao-dual.sql` | motor de regras com vigência, apuração dual e memória de cálculo |
| 7 | `07-reporting.sql` | catálogo das trilhas de auditoria (12 trilhas) e a tabela do Book de fechamento |
| 8 | `08-contra-apuracao.sql` | proposta do Fisco, divergências nota a nota e o calendário da carteira |
| 9 | `09-assistente-fiscal.sql` | conversas do assistente e a cota mensal por CNPJ, tirada do plano |
| 10 | `10-credito-por-fornecedor.sql` | extrato bancário, casamento pagamento × documento e o crédito em risco |
| 11 | `11-simulador-de-regime.sql` | registro das simulações de regime, com as premissas usadas |
| 12 | `12-dossie-saldo-credor.sql` | EFD-Contribuições importada e a janela de cobertura documental |
| 13 | `13-correcao-propagacao.sql` | correção: a propagação de item ignorava o item nunca classificado |
| 14 | `14-bootstrap-escritorio.sql` | **editar antes** — cria o escritório e vincula seu usuário |

> **Os arquivos são renumerados quando uma onda nova entra.** Se você já aplicou
> uma versão anterior, rode os que faltam e ignore o bootstrap — ele é
> idempotente e avisa que o usuário já pertence a um escritório. `npm run doctor`
> diz exatamente quais tabelas faltam e de qual arquivo elas vêm.

> **Já aplicou até o `12-dossie-saldo-credor.sql`?** Rode só o
> `13-correcao-propagacao.sql`. É um `create or replace` de função, seguro de
> reaplicar. O bootstrap é o último passo e mudou de número (agora é `14`); você
> já o executou, e reexecutá-lo não faria diferença — é idempotente.

Antes de executar o passo 14, edite as duas linhas marcadas:

```sql
  -- ┌──────────────────────────── CONFIGURE ────────────────────────────┐
  v_email       text := 'voce@seudominio.com.br';
  v_escritorio  text := 'Meu Escritório de Contabilidade';
  -- └───────────────────────────────────────────────────────────────────┘
```

O passo 14 termina com uma consulta de conferência. Deve devolver **uma linha**
com o seu e-mail e o papel `owner`:

```
tenant_id                            | escritorio    | plano | usuario           | papel
-------------------------------------+---------------+-------+-------------------+-------
536e54ae-e3df-42d7-9393-8a3dcab85f58 | Seu Escritório| trial | voce@dominio.br   | owner
```

Se preferir colar tudo de uma vez, use
[`scripts/sql/setup-completo.sql`](../../scripts/sql/setup-completo.sql) — mesmo
conteúdo, um arquivo só. Um erro no meio de 700 linhas é mais difícil de
localizar, por isso o padrão é passo a passo.

Tudo é **idempotente**: rodar de novo não duplica nada.

---

## 3. Configure o `.env`

Copie `.env.example` para `.env` se ainda não existir. O `.env` é ignorado pelo
git — nunca comite.

```bash
DATABASE_URL=postgresql://postgres.SEU-REF:SENHA@aws-0-SUA-REGIAO.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://SEU-REF.supabase.co
SUPABASE_ANON_KEY=sua-chave-anon
SUPABASE_JWKS_URL=https://SEU-REF.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_AUDIENCE=authenticated
CERTIFICATE_MASTER_KEY=gere-com-openssl-rand-base64-48
```

**`DATABASE_URL`** — copie do painel em **Connect**. Prefira **Session pooler**
ou **Transaction pooler**; evite *Direct connection* (motivo abaixo, em
Problemas conhecidos). Faça URL-encode de caracteres especiais na senha:
`@` → `%40`, `#` → `%23`, `:` → `%3A`.

**`SUPABASE_JWKS_URL`** — este projeto usa chaves assimétricas (ES256), então a
verificação do token é por chave pública e **não há segredo compartilhado**.
Se o seu projeto ainda usar o JWT secret legado (HS256), troque por
`SUPABASE_JWT_SECRET`; a API aceita as duas formas.

**`CERTIFICATE_MASTER_KEY`** — cifra o PFX dos certificados A1 em repouso:

```bash
openssl rand -base64 48
```

> Guarde uma cópia num gerenciador de segredos **antes de ir a produção**.
> Trocar esta chave torna ilegíveis todos os certificados já armazenados.

---

## 4. Confira o ambiente antes de subir a API

```bash
npm ci
npm run doctor
```

A primeira linha da saída diz se o `.env` foi lido e quantas variáveis vieram
dele. **O ambiente real tem precedência sobre o arquivo**: uma variável já
definida no shell não é sobreposta pelo `.env`, e o doctor informa quantas
ignorou por esse motivo — é o que evita editar o arquivo e não entender por que
nada mudou.

Verifica, em ordem: variáveis obrigatórias, conexão, as 15 tabelas, as 5
funções, o trigger append-only de `events`, a carga inicial de cobrança e a
existência de um escritório com `owner`. Cada falha vem com a ação:

```
[ ok ] variáveis de ambiente
[ ok ] conexão com o banco
       PostgreSQL 16.15 · base postgres
[ ok ] schema
       15 tabelas
[FALHA] carga inicial de cobrança
       0 planos (esperado 5), 0 linha(s) de parâmetros (esperado 1)
       -> Os INSERT de carga não entraram. Reaplique
          scripts/sql/migracoes/03-cobranca.sql — é idempotente.
```

Existe porque nenhum desses problemas se anuncia: schema aplicado pela metade
devolve 200 com lista vazia, e a falta de `memberships` devolve 403 em tudo.

Sai com código 0 quando está tudo pronto, e 1 quando há o que resolver.

### Se o doctor não conseguir conectar

Rode o diagnóstico direto no SQL Editor:

```
scripts/sql/diagnostico.sql
```

Não altera nada, só relata. Devolve **um único resultado** de propósito: o SQL
Editor do Supabase mostra apenas a saída da última instrução quando o script tem
várias, então uma versão com vários `SELECT` esconderia todas as checagens menos
a final.

A linha `movimento` mostra contagens de CNPJs, competências, eventos e
documentos. **Zeros ali são esperados** antes do primeiro cadastro e não indicam
falha — o que importa são as linhas com estado `FALHA`.

Responde também o que de fora não se distingue: uma tabela que devolve lista
vazia na API REST pode estar **sem dados** ou com **RLS ligada sem policy**. As
duas são indistinguíveis pelo cliente e a correção é diferente. O script roda
como `postgres`, ignora RLS, e mostra as duas coisas lado a lado.

## 5. Suba a API

```bash
npm run dev
```

```bash
curl -s localhost:3000/v1/health                       # {"status":"ok"}
curl -s localhost:3000/v1/plans | head -c 200          # rota pública, lê do banco
```

Se `/v1/health` responde mas `/v1/plans` dá 500, o problema é o `DATABASE_URL`.
Se `/v1/plans` responde com a lista de planos **vazia**, a carga inicial não
entrou — reaplique `03-cobranca.sql`.

---

## 6. Teste o fluxo de ponta a ponta

### Autenticar

```bash
TOKEN=$(curl -s -X POST localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"voce@seudominio.com.br","password":"SUA-SENHA"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -s localhost:3000/v1/me -H "Authorization: Bearer $TOKEN"
```

Deve devolver seu usuário com `role: owner` e o escritório.

### Cadastrar uma empresa

```bash
curl -s -X POST localhost:3000/v1/clients \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cnpj":"12345678000195","legal_name":"Padaria do Bairro LTDA",
       "regime":"simples_hibrido","uf":"SP"}'
```

Devolve `event_seq: 0` e o `projection_hash`. O cadastro nasceu de um evento
`client.enrolled` — não de um `INSERT`.

### Abrir a competência

```bash
curl -s -X POST localhost:3000/v1/clients/12345678000195/periods \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"period":"2027-08"}'
```

> A competência precisa existir **antes** de ingerir documentos. Abrir é o
> contador declarando que trabalha naquele mês; auto-abrir criaria competências
> em silêncio a partir de qualquer nota antiga que chegasse na distribuição DF-e.

### Ingerir XMLs

```bash
curl -s -X POST localhost:3000/v1/clients/12345678000195/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F 'files=@/caminho/nota1.xml' -F 'files=@/caminho/nota2.xml'
```

Responde **207** com `accepted[]` e `rejected[]`. Um arquivo com problema não
interrompe o lote: as outras notas entram, e cada rejeição traz `layer`,
`reason` e `message` em português.

### Conferir a trilha

```bash
curl -s localhost:3000/v1/clients/12345678000195/events -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/v1/clients/12345678000195/verify -H "Authorization: Bearer $TOKEN"
```

O `verify` reprojeta o log do zero e compara hashes. Tem de devolver
`"ok": true` com `stored_hash == replayed_hash`.

---

## Problemas conhecidos

### `ENETUNREACH` ao conectar no banco

O host de conexão direta (`db.SEU-REF.supabase.co`) tem **apenas endereço
IPv6**. Máquinas sem rota IPv6 nunca o alcançam.

Diagnóstico:

```bash
getent ahostsv4 db.SEU-REF.supabase.co   # vazio = o host é só IPv6
ip -6 route show default                  # vazio = esta máquina não tem rota IPv6
ip -4 addr show eth0                      # 172.x.x.x no WSL = modo NAT
```

#### A saída normal: usar o pooler (IPv4, nada a mexer na máquina)

O hostname do pooler **não é previsível**: o prefixo varia entre `aws-0` e
`aws-1`, e a região não aparece em nenhum lugar público. Descubra o seu:

```bash
npm run pooler -- SEU-REF
```

A ferramenta não precisa da senha. Ela sonda os hostnames e usa a diferença nas
mensagens de erro do pooler para identificar o certo:

| Mensagem | Significado |
|---|---|
| `Tenant or user not found` | hostname errado |
| `password authentication failed` | hostname **certo**, só a senha é inválida |

Essa distinção importa porque as duas situações são indistinguíveis a olho nu —
sondar só o prefixo `aws-0` levou à conclusão errada de que o projeto não tinha
pooler.

O resultado já vem no formato do `DATABASE_URL`. Repare que o usuário passa a
ser `postgres.<project-ref>`, não `postgres`.

#### Alternativas, se a conexão direta for requisito

As duas abaixo só fazem sentido se alguma ferramenta do seu fluxo exigir
`db.SEU-REF.supabase.co`.

#### 1. Habilitar IPv6 no WSL

O WSL em modo **NAT** — o padrão, reconhecível pelo IP `172.x.x.x` — não
repassa IPv6, mesmo quando o Windows tem. O modo **mirrored** dá ao WSL a pilha
de rede do host, IPv6 incluído.

Exige Windows 11 22H2+ e WSL 2.0+; confira com `wsl.exe --version`.

Crie `C:\Users\SEU-USUARIO\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

No PowerShell, reinicie o WSL:

```powershell
wsl --shutdown
```

Reabra o terminal e confirme:

```bash
ip -6 route show default   # agora deve mostrar uma rota
npm run doctor
```

#### 2. Add-on de IPv4 do Supabase

Dá um endereço IPv4 ao host direto. É pago e mensal; só vale se a conexão direta
for requisito de outras ferramentas do seu fluxo.

### `invalid_credentials` mesmo com a senha certa

O usuário não foi confirmado. No painel, abra o usuário em **Authentication →
Users** e confirme, ou recrie marcando **Auto Confirm User**.

### `password authentication failed`

Senha do banco errada, ou caractere especial sem URL-encode. Redefina em
**Project Settings → Database → Reset database password**.

### `/v1/plans` devolve lista vazia

A carga inicial de `plans` não entrou. Rode
[`scripts/sql/reparo-planos.sql`](../../scripts/sql/reparo-planos.sql): ele
insere **um plano por instrução**, com o erro capturado individualmente, e
relata qual linha falhou e por quê. Um `insert ... on conflict do nothing` em
bloco, como o da migration, não diz nada quando falha.

Ele também confere o tipo `public.regime`, religa o RLS desligado dessas duas
tabelas e concede `select` a `anon` — tudo o que a calculadora de preço pública
precisa para responder.

> O reparo **restaura os preços canônicos**. Se você já ajustou valores em
> `plans`, anote antes: ao contrário da migration, ele sobrescreve.

Este é um caso que aconteceu de verdade nesta instalação: as 15 tabelas foram
criadas e os `insert` de carga não. A API não reclama — a calculadora de preço
simplesmente mostra nada, e a fatura só falha no fechamento do mês.

### `Failed to fetch (api.supabase.com)` no dashboard

É o **dashboard** falando com a API de gestão do Supabase, não o seu SQL. O
projeto pode estar perfeitamente no ar enquanto o painel falha.

Verifique antes de mexer em qualquer coisa:

```bash
curl -s https://status.supabase.com/api/v2/status.json
curl -s https://status.supabase.com/api/v2/incidents/unresolved.json
```

E confirme que o seu projeto responde, o que é independente do painel:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://SEU-REF.supabase.co/auth/v1/settings -H 'apikey: SUA-CHAVE-ANON'
```

Havia um incidente aberto em setembro de 2026 — *"401 errors due to JWT
rejections"*, no API Gateway — cuja resolução exigia **atualizar a versão do
projeto pelo dashboard** depois que o Supabase implantasse o fix. Se o erro
persistir, procure o aviso de upgrade em **Project Settings → Infrastructure**.

### Saúde do cadastro diz "não verificado"

As tabelas oficiais de códigos (`fiscal_codes`, `cclasstrib_cst`) estão vazias.

Isso é deliberado, não um defeito: validar um NCM ou cClassTrib contra tabela
vazia aprovaria **qualquer** código, o que é pior do que não validar. Então a
API reporta `not_verified` e a resposta de `/items/health` traz um `notice`
dizendo que a ausência de erro ali não significa que a classificação está
correta.

Para sair desse estado, carregue os códigos da IT RT 2025.002 e das tabelas da
RFB em `fiscal_codes` e os pares válidos em `cclasstrib_cst`. É tarefa de dado,
não mudança de código — `npm run doctor` avisa enquanto estiverem vazias.

### Apuração devolve `due: null`

Não é defeito: é a recusa deliberada de calcular o valor devido sem regra
publicada. Débito e crédito potencial saem dos valores destacados nos próprios
documentos e estão sempre disponíveis; decidir se um crédito é **aproveitável**
depende do regime e da norma vigente.

Um número fiscal errado é pior do que um ausente: o ausente o contador
investiga, o errado ele entrega. Então o campo vem `null` com o motivo em
`not_computable`.

Para sair desse estado, publique as regras em `tax_rules` com a fonte
normativa — a coluna `source` é obrigatória de propósito. `npm run doctor`
avisa enquanto não houver nenhuma.

### `403 Usuário não pertence a nenhum escritório`

O passo 5 do SQL não rodou, ou rodou com outro e-mail. Confira:

```sql
select u.email, t.name, m.role
  from memberships m
  join tenants t on t.id = m.tenant_id
  join auth.users u on u.id = m.user_id;
```

### `404` num CNPJ que existe

Ele pertence a outro escritório. A API responde 404 e não 403 de propósito: um
403 confirmaria que aquele CNPJ está cadastrado na plataforma, e carteira é
informação comercial sensível diante de um concorrente.

---

## Alternativa: aplicar por linha de comando

Se a máquina alcança o banco, dá para pular o SQL Editor:

```bash
npx tsx scripts/setup-supabase.ts \
  --escritorio "Seu Escritório" \
  --email voce@seudominio.com.br
```

Faz o mesmo que os cinco passos: aplica as migrations, localiza o usuário e cria
o escritório. Também é idempotente.

---

## Referências

- Contrato da API: [`docs/api/openapi.yaml`](../api/openapi.yaml)
- Telas do painel: [`docs/integration/TELAS.md`](../integration/TELAS.md)
- Decisões de arquitetura: [`docs/adr/`](../adr/)
- Briefing de produto: [`docs/product/BRIEFING-SAAS-FISCAL.md`](../product/BRIEFING-SAAS-FISCAL.md)
