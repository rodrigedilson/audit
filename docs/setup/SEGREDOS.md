# Segredos: Doppler e a rotação da chave do cofre

> **Para quem é este documento:** quem opera o `audit` em produção. Descreve onde
> os segredos moram e como trocar a chave mestra do cofre de certificados sem
> tornar ilegível o acervo.

## Por que a chave do cofre é diferente dos outros segredos

`CERTIFICATE_MASTER_KEY` cifra, com AES-256-GCM, todo certificado A1 guardado. Ela
não é como uma chave de API, que se troca e pronto:

- **A senha do PFX não é guardada.** Ela abre o arquivo, extrai os metadados,
  cifra o conteúdo e é descartada. Não há cópia em lugar nenhum.
- **Logo, perder a chave é perder o acervo.** A única recuperação é pedir a cada
  cliente que reenvie o certificado com a senha.
- **E custodiar A1 de terceiro é o que torna ISO 27001 / SOC 2 pré-requisito
  comercial**, não luxo. A primeira pergunta de uma auditoria é "quem leu a
  chave, e quando" — e variável de ambiente no painel do provedor não responde.

## Ambientes dev e prod

Os dois ambientes usam a **mesma infraestrutura**: um repositório git por
aplicação (`audit` e `sped-genius-hub`), um projeto Supabase, um projeto no
Doppler, um serviço no Render e um projeto na Vercel. O que muda entre eles é o
config do Doppler e a variável `AUDIT_ENV`.

| | dev | prod |
|---|---|---|
| Onde roda | máquina local: API em `:3000`, front em `:5173` | Render (API) e Vercel (front) |
| Branch | qualquer uma | `main` |
| Projeto Supabase | `uflputiyytswvagrrzzn` | o mesmo |
| Config no Doppler | `audit` / `dev` | `audit` / `prd` |
| `AUDIT_ENV` | `dev` | `prod` |
| Asaas | sem chave | produção |
| `CORS_ORIGINS` | opcional (padrão: Vite local) | obrigatória |
| `TRUST_PROXY` | opcional (padrão `false`) | obrigatória, `true` |

### O banco é compartilhado

Tudo o que se faz em dev grava no banco de produção. Consequências:

- **A suíte de testes nunca roda contra ele.** `TEST_DATABASE_URL` é o Postgres
  local (`localhost:55432`), e `tests/setup/global-db.ts` se recusa a rodar se
  `DATABASE_URL` for outra coisa. Já houve evento de teste gravado no log de
  produção antes dessa trava existir.
- **Em dev, trabalhe num escritório de teste**, nunca na carteira de um cliente.
  O log é append-only: um evento gravado por engano não se apaga.
- **A chave do cofre é a mesma nos dois configs.** Com chaves diferentes, o
  certificado enviado em dev ficaria ilegível em produção, e vice-versa. O `dev`
  referencia o valor do `prd` (`${prd.CERTIFICATE_MASTER_KEY}`) em vez de
  copiá-lo, então uma rotação não deixa os dois divergindo.
- **Asaas fica sem chave em dev.** Uma chave de sandbox gravaria IDs de cliente e
  de assinatura do sandbox nas tabelas de cobrança de produção.
- **Cargas de referência e migrations rodam uma vez só**: valem para os dois.

### O que `AUDIT_ENV` confere no start

Não há padrão: se a variável faltar, a API e a CLI não sobem
(`src/config/env.ts`).

- **prod** exige `CORS_ORIGINS` e `TRUST_PROXY=true`: a API fica atrás do proxy do
  Render, e sem ele todo visitante chega com o IP do proxy, e a quota do
  diagnóstico público e o limite de login viram um balde único. Se houver
  `ASAAS_API_KEY`, exige também
  `ASAAS_BASE_URL=https://api.asaas.com/v3` e `ASAAS_WEBHOOK_TOKEN`: sem a URL, a
  chave de produção ia para o sandbox sem erro nenhum.
- **dev** recusa `ASAAS_BASE_URL` de produção.

`npm run doctor` mostra o ambiente detectado na primeira linha.

## Doppler

O critério para escolher não foi preço: é ter **log de acesso** e **rotação
versionada**. O painel do Render guarda o valor e não diz quem o leu.

## Passo a passo

O projeto `audit` no Doppler, o serviço no Render e o projeto na Vercel já
existem. O que falta é marcar o ambiente em cada um.

> **A ordem importa.** O passo 1 vem antes de fazer merge da branch que introduz
> `AUDIT_ENV`. Se a variável não estiver no `prd` quando o Render fizer o deploy,
> a API não sobe.

### 1. Doppler: marcar os dois configs

> **O CLI é opcional para a rotação.** Criar o projeto, guardar os segredos e
> ligar a integração com o Render se fazem inteiros no painel do Doppler. O CLI
> serve para rodar o projeto localmente (`doppler run`) e para os scripts de
> recifragem.

```bash
# Antes de tudo: instalar e autenticar o CLI.
#
# O comando da documentação oficial — `curl … | sh` — usa o gerenciador de
# pacote e falha sem root: `dpkg: requested operation requires superuser
# privilege`. Com `--install-path` ele desliga o gerenciador e instala no
# diretório do usuário, que é o que se quer numa máquina de desenvolvimento.
mkdir -p "$HOME/.local/bin"
curl -Ls https://cli.doppler.com/install.sh | sh -s -- --install-path "$HOME/.local/bin"

# Se `doppler` não for encontrado depois, falta o diretório no PATH:
# export PATH="$HOME/.local/bin:$PATH"

doppler login

doppler secrets set AUDIT_ENV=prod TRUST_PROXY=true --project audit --config prd
doppler secrets set CORS_ORIGINS=https://sped-genius-hub.vercel.app --project audit --config prd

doppler secrets set AUDIT_ENV=dev --project audit --config dev

# O dev referencia o prd em vez de copiar: mesmo banco, mesma chave do cofre, e
# uma rotação no prd já vale para os dois.
doppler secrets set --project audit --config dev \
  'DATABASE_URL=${prd.DATABASE_URL}' \
  'SUPABASE_URL=${prd.SUPABASE_URL}' \
  'SUPABASE_ANON_KEY=${prd.SUPABASE_ANON_KEY}' \
  'SUPABASE_JWKS_URL=${prd.SUPABASE_JWKS_URL}' \
  'SUPABASE_JWT_AUDIENCE=${prd.SUPABASE_JWT_AUDIENCE}' \
  'CERTIFICATE_MASTER_KEY=${prd.CERTIFICATE_MASTER_KEY}' \
  'LOG_LEVEL=debug'
```

Confira que os dois têm as obrigatórias (`DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_JWKS_URL`, `CERTIFICATE_MASTER_KEY`) e que o `dev`
não tem `ASAAS_API_KEY`:

```bash
doppler secrets --project audit --config prd --only-names
doppler secrets --project audit --config dev --only-names
```

Nunca rode `doppler secrets upload` com o arquivo local: ele tem variáveis de
teste, e subir tudo leva junto o que não devia estar lá.

### 2. Render: API em produção

O serviço recebe os segredos pela integração nativa do Doppler (*Integrations →
Render → Sync*, config `prd`). Não copie e cole: a integração sincroniza e mantém
o log de leitura. Se ainda houver variável definida direto no painel do Render,
remova-a. Duas fontes para o mesmo segredo é como uma fica velha sem ninguém
notar.

Depois do sync, o Render faz o deploy a partir de `main`. Para conferir:

```bash
doppler run --project audit --config prd -- npm run doctor
```

A primeira linha tem de dizer `ambiente prod`.

### 3. Vercel: front em produção

No projeto `sped-genius-hub`, em *Settings → Environment Variables*, ambiente
**Production**:

```bash
VITE_AUDIT_API_URL=https://<servico-da-api>.onrender.com
VITE_SUPABASE_URL=https://uflputiyytswvagrrzzn.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon key do projeto>
```

Os *preview deploys* da Vercel não funcionam contra a API. Cada preview tem uma
URL nova, e `CORS_ORIGINS` só aceita origens exatas, sem curinga. Para testar uma
branch do front, rode-o localmente (passo 4).

### 4. Local: dev

```bash
# API (este repo)
doppler run --project audit --config dev -- npm run serve

# Front (../sped-genius-hub), com VITE_AUDIT_API_URL=http://localhost:3000
npm run dev
```

Para trabalhar offline, o arquivo de ambiente local substitui o Doppler. Ele
precisa ter `AUDIT_ENV=dev`. E não pode ter `TEST_DATABASE_URL` junto da
`DATABASE_URL` de produção: a suíte de testes se recusa a rodar assim.

### 5. Conferir

```bash
doppler run --project audit --config dev -- npm run doctor   # ambiente dev
doppler run --project audit --config prd -- npm run doctor   # ambiente prod
```

## Assistente fiscal, camada 3 (Anthropic)

**Estado em 2026-09-24:** o código está pronto, e a chave ainda não está no
Doppler. Sem ela, o assistente responde as perguntas da lista, por consulta
determinística e com citação, e diz "não sei, e eis o que sei" para as outras. O
`npm run doctor` mostra `assistente só na camada 1` na linha das variáveis.

Quando houver chave:

```bash
doppler secrets set ANTHROPIC_API_KEY --project audit --config prd
# opcional; o padrão é claude-opus-5, a camada 3 do ADR-026
doppler secrets set ASSISTANT_MODEL=claude-opus-5 --project audit --config prd
```

Em `dev` a chave pode existir: o assistente só grava em `assistant_messages`,
que é conversa e não apuração. Mas cada pergunta fora da lista custa uma chamada
ao modelo. Use uma chave com limite de gasto próprio, e não a de produção.

O `doctor` passa a dizer `assistente camada 3 com claude-opus-5`, e
`GET /v1/assistant/capabilities` passa a devolver `language_model_configured: true`.

## E-mail do diagnóstico público

O diagnóstico oferece "receba o relatório por e-mail". O envio é por **SMTP**, e
não por um fornecedor fixo: serve o servidor de e-mail do domínio próprio
(Google Workspace, Microsoft 365, Zoho, Locaweb, o servidor da hospedagem) ou
qualquer serviço de envio que aceite SMTP. Sem as variáveis, o diagnóstico
funciona, o lead é gravado e a resposta diz `email_sent: false`, com o motivo
`mail_not_configured`.

```bash
# URL do SMTP: smtps:// na porta 465 (TLS direto) ou smtp:// na 587 (STARTTLS).
# Usuário e senha com caractere especial vão codificados em URL (@ vira %40).
doppler secrets set MAIL_SMTP_URL='smtps://diagnostico%40seu-dominio.com.br:SENHA@smtp.seu-provedor.com:465' --project audit --config prd
doppler secrets set MAIL_FROM='Diagnóstico <diagnostico@seu-dominio.com.br>' --project audit --config prd
# Base pública da API, para o link "apagar meu e-mail" que vai no corpo.
doppler secrets set PUBLIC_API_URL=https://SUA-API.onrender.com --project audit --config prd

# Chave própria do relatório guardado por 24h, e o segredo do hash do IP.
doppler secrets set REPORT_ENCRYPTION_KEY="$(openssl rand -base64 48)" --project audit --config prd
doppler secrets set IP_HASH_SECRET="$(openssl rand -base64 48)" --project audit --config prd
```

- **As três de e-mail vão juntas.** `loadEnv` recusa só parte delas: sem a URL
  pública, o e-mail sairia sem o link de remoção.
- **SPF e DKIM** do domínio do `MAIL_FROM` precisam autorizar o servidor SMTP.
  Sem isso o relatório cai em spam, ou é recusado. Muitos provedores de
  domínio pedem ainda uma senha de aplicativo em vez da senha da conta.
- **`REPORT_ENCRYPTION_KEY`** não é a chave do cofre: o relatório traz CNPJ e
  razão social de fornecedores do visitante, e vazar uma chave não pode abrir o
  outro acervo. Sem ela nada é guardado e não há o que enviar.
- **`IP_HASH_SECRET`** desacopla a quota do diagnóstico da chave do cofre. Ao
  ligá-la, a quota diária de cada IP recomeça do zero, uma vez.
- Em `dev` o envio pode ficar ligado: quem testa recebe o próprio relatório.

O `doctor` mostra `e-mail do diagnóstico` como aviso enquanto faltar algo, e
avisa também de envio falhando nos últimos 7 dias (`readiness_reports.email_error`).
Os leads saem em CSV com `npx tsx scripts/exportar-leads.ts`, só leitura.

## Rotação da chave mestra

O cofre aceita **duas chaves ao mesmo tempo**: cifra sempre com a atual, decifra
com a atual ou a anterior. É isso que torna a rotação possível sem perder o
acervo. Cada linha de `certificates` guarda `key_id` — o identificador público da
chave que a cifrou, derivado por HMAC e sem nada de secreto.

### Passo 1 — medir o acervo

```bash
npm run doctor
```

A checagem **cofre de certificados A1** diz quantos há e quantos estão fora da
chave atual. É a verificação que não depende do secret manager: um comando
responde se sobrou certificado na chave antiga, em vez de a resposta aparecer no
dia em que a coleta de DF-e falha.

Ou, direto no banco:

```sql
select coalesce(key_id, '(anterior à rotação)') as chave, count(*)
  from certificates group by 1 order by 2 desc;
```

Zero certificados: troque a chave e pule para o passo 5. **É o estado de hoje em
produção** — a rotação agora custa nada, e depois de haver certificado passa a
exigir a recifragem do acervo.

### Passo 2 — gerar a nova chave

```bash
openssl rand -base64 48
```

### Passo 3 — subir as duas

```bash
doppler secrets set CERTIFICATE_MASTER_KEY_PREVIOUS="$(doppler secrets get CERTIFICATE_MASTER_KEY --plain --project audit --config prd)" --project audit --config prd
doppler secrets set CERTIFICATE_MASTER_KEY="<a nova>" --project audit --config prd
```

Faça o deploy e **confirme que o cofre ainda abre** antes de seguir: abra um
cliente com certificado no painel. A partir daqui, cada novo upload já entra com
a chave nova; os antigos continuam legíveis pela anterior.

### Passo 4 — recifrar o acervo

```bash
doppler run --project audit --config prd -- npx tsx scripts/recifrar-certificados.ts
doppler run --project audit --config prd -- npx tsx scripts/recifrar-certificados.ts --executar
```

O script é idempotente, usa uma transação por linha e **confere o fingerprint
antes de regravar** — uma linha cujo conteúdo não confere é pulada e reportada,
em vez de ser carimbada com a chave nova.

Repita o passo 1 até `key_id` ser um só — `npm run doctor` volta a dizer
"todos na chave X".

### Passo 5 — remover a anterior

Só depois de o passo 1 mostrar uma única chave:

```bash
doppler secrets delete CERTIFICATE_MASTER_KEY_PREVIOUS --project audit --config prd
```

O cofre recusa subir com a anterior **igual** à atual, então uma variável
esquecida vira erro no start em vez de configuração silenciosa.

## Se a chave for perdida

Não há recuperação técnica. O procedimento é:

1. Levante quais clientes têm certificado guardado e avise cada escritório.
2. Publique uma chave nova e **não** defina a anterior: assim o cofre falha alto
   ao tentar abrir o que não consegue, em vez de devolver erro genérico.
3. Cada certificado precisa ser reenviado com a senha. O histórico de uso
   permanece no event log — remover o certificado nunca apagou a trilha.
4. Registre o incidente. Para ISO 27001, perda de material criptográfico é
   evento reportável, e a resposta documentada é parte do controle.
