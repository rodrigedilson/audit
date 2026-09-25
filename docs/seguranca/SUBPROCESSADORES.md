# Sub-processadores

Quem, além de nós, processa dado de cliente. É a primeira pergunta de qualquer
questionário de segurança e a lista que um contrato de tratamento de dados
precisa anexar.

Escrito a partir do código e da configuração, não de memória: cada linha aponta
onde a integração vive. Ao ligar uma integração nova, **a linha entra aqui antes
de a chave entrar no Doppler** — lista desatualizada é pior que lista ausente,
porque quem a lê para de conferir.

> Estado em 25/09/2026, conferido com `npm run doctor` contra produção.
>
> A primeira versão deste documento afirmou que não havia provedor de e-mail.
> Era verdade quando foi escrita e deixou de ser no mesmo dia, com o envio do
> relatório do diagnóstico público. É exatamente o risco que o parágrafo acima
> descreve, e serve de lembrete de que a linha entra aqui **antes** da chave.

## Processam dado de cliente

| Quem | Para quê | O que recebe | Situação |
|---|---|---|---|
| **Supabase** | Banco (Postgres), autenticação e emissão de JWT | **Tudo**: event log, CNPJs e razões sociais da carteira, documentos fiscais, apurações, e os PFX **cifrados** dos certificados A1 (coluna `certificates.encrypted_pfx`). Os e-mails dos usuários vivem no `auth.users`, que é do Supabase | Ativo |
| **Render** | Hospedagem da API | Tudo o que passa pela API, em memória e em log de aplicação | Ativo |
| **Vercel** | Hospedagem do front | Não recebe dado fiscal: serve um SPA estático, e o navegador fala direto com a API. Recebe metadado de acesso — IP e user-agent de quem abre o painel | Ativo |
| **Anthropic** | Camada 3 do assistente fiscal | A pergunta do contador e as evidências já selecionadas pela camada 1 ([`claude-language-model.ts`](../../src/fiscal/assistant/claude-language-model.ts)). São trechos do dado fiscal do CNPJ | Só com `ANTHROPIC_API_KEY` |
| **Servidor SMTP** (`MAIL_SMTP_URL`) | Entrega do relatório do diagnóstico público | Nome e e-mail do lead, e o link do relatório. O provedor concreto é quem a URL apontar; SPF e DKIM do domínio do `MAIL_FROM` são parte da configuração | Só com `MAIL_SMTP_URL` — hoje desligado em produção |
| **Asaas** | Cobrança | Nome e CNPJ do escritório, e o e-mail quando informado ([`asaas-client.ts`](../../src/billing/asaas-client.ts)). **Não** recebe dado fiscal dos clientes finais | Só com `ASAAS_API_KEY` — hoje desligado em produção |

## Guarda segredo, e por isso entra na lista

| Quem | Para quê | Por que importa |
|---|---|---|
| **Doppler** | Secret manager | Não recebe dado de cliente nenhum. Guarda a **chave mestra do cofre**, e quem a tiver decifra todo PFX guardado. Materialmente, é a peça mais sensível da lista |

## Não são sub-processadores

Aparecem aqui porque a pergunta vai surgir, e "não sei" é pior resposta que a
explicação.

| Quem | Por que não |
|---|---|
| **SEFAZ, Receita Federal, SVRS** | São o Fisco, destinatário legal da informação. O certificado A1 é usado para **nos autenticar perante eles**, não para que tratem dado por nossa conta |
| **Conformidade Fácil (SVRS)** | Consulta de tabela oficial de códigos. O tráfego é de ida: perguntamos a tabela, não enviamos dado de cliente |
| **GitHub** | Guarda o código, não o dado. Um segredo commitado o tornaria sub-processador por acidente — é o que a varredura do gitleaks existe para impedir |

## O que a lista muda quando muda

Ligar `ANTHROPIC_API_KEY` ou `ASAAS_API_KEY` **não é decisão técnica**: passa a
existir um sub-processador novo recebendo dado de cliente, e o contrato com o
escritório precisa refleti-lo antes. O `npm run doctor` diz quais estão ligados.

Ligar `MAIL_SMTP_URL` também não é decisão só técnica: passa a sair e-mail com
dado de lead por um terceiro. O `npm run doctor` diz quais estão ligados.
