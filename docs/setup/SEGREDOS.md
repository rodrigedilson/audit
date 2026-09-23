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

## Doppler

O critério para escolher não foi preço: é ter **log de acesso** e **rotação
versionada**. O painel do Render guarda o valor e não diz quem o leu.

### Configuração inicial

```bash
# 1. Instale e autentique
curl -Ls https://cli.doppler.com/install.sh | sh
doppler login

# 2. Crie o projeto e os ambientes
doppler projects create audit
doppler environments create prd producao --project audit

# 3. Importe o que já existe, conferindo item a item.
#    NÃO faça `doppler secrets upload .env`: o .env local tem a URL do banco de
#    produção e variáveis de teste, e subir o arquivo inteiro leva junto o que
#    não devia estar lá.
doppler secrets set CERTIFICATE_MASTER_KEY --project audit --config prd
doppler secrets set DATABASE_URL --project audit --config prd
doppler secrets set SUPABASE_URL SUPABASE_ANON_KEY --project audit --config prd
```

### No Render

Use a integração nativa do Doppler, e não copiar e colar: a integração sincroniza
e mantém o log de leitura. No Doppler, *Integrations → Render → Sync*, apontando
para o serviço da API e o config `prd`.

Depois de sincronizar, **remova as variáveis do painel do Render**. Duas fontes
para o mesmo segredo é como uma fica velha sem ninguém notar.

### Localmente

```bash
doppler run --project audit --config dev -- npm run dev
```

O `.env` continua existindo para desenvolvimento offline. Ele **não** deve ter a
chave de produção — e não deve ter `DATABASE_URL` de produção junto de
`TEST_DATABASE_URL`, porque a suíte se recusa a rodar assim (ver
`tests/setup/global-db.ts`, e a razão: já houve evento de teste gravado no log de
produção por causa disso).

## Rotação da chave mestra

O cofre aceita **duas chaves ao mesmo tempo**: cifra sempre com a atual, decifra
com a atual ou a anterior. É isso que torna a rotação possível sem perder o
acervo. Cada linha de `certificates` guarda `key_id` — o identificador público da
chave que a cifrou, derivado por HMAC e sem nada de secreto.

### Passo 1 — medir o acervo

```sql
select coalesce(key_id, '(anterior à rotação)') as chave, count(*)
  from certificates group by 1 order by 2 desc;
```

Zero certificados: troque a chave e pule para o passo 5.

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

Repita o passo 1 até `key_id` ser um só.

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
