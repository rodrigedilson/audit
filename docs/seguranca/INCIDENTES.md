# Resposta a incidente

O que fazer quando algo dá errado, escrito antes de dar. Um plano consultado
durante o incidente é um plano; escrito durante, é improviso com nome bonito.

Não é genérico: as classes abaixo são as deste sistema, e cada uma aponta a
ferramenta que já existe para detectar, conter e comprovar.

## Antes de tudo: o relógio

A [Resolução CD/ANPD nº 15/2024](https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis)
dá **três dias úteis** para a comunicação preliminar à ANPD e **vinte dias
úteis** para o relatório complementar. Aos titulares, "sem demora injustificada".

A obrigação nasce quando há risco ou dano relevante — não em todo incidente. Mas
a contagem começa no **conhecimento do fato**, não na conclusão da apuração. Na
dúvida, comunique: o custo de comunicar sem precisar é constrangimento; o de não
comunicar precisando é sanção.

O sigilo fiscal do art. 198 do CTN é independente disso e mais restritivo. Um
vazamento de dado fiscal de cliente é problema mesmo quando não há dado pessoal.

## Quem aciona

Hoje a operação é de uma pessoa, e negar isso num documento de auditoria não
engana ninguém. **Edilson aciona e decide.** O que o plano faz é impedir que a
ordem dos passos dependa da memória de quem está com adrenalina.

Quando houver segunda pessoa, este é o parágrafo que muda.

## As cinco classes

### 1. Chave mestra do cofre exposta

**O que significa.** Quem tem a chave decifra todo PFX guardado, e com um PFX
age perante o Fisco em nome da empresa. É o pior caso da lista.

**Como se percebe.** Acesso indevido ao Doppler, segredo em log, chave em
mensagem. O gitleaks pega o caso de commit; os outros dependem de alguém notar.

**Primeira hora.**
1. Rotacionar a chave — procedimento em [`../setup/SEGREDOS.md`](../setup/SEGREDOS.md),
   seção *Rotação da chave mestra*. O cofre aceita duas chaves ao mesmo tempo,
   então a rotação não derruba o acervo.
2. `npm run doctor` para conferir quantos certificados ficaram na chave antiga.
3. Recifrar o acervo com `scripts/recifrar-certificados.ts`.
4. Revogar o acesso de quem quer que tenha alcançado o Doppler.

**Comunicar.** Aos escritórios cujos certificados estavam guardados — são eles
que podem precisar revogar o A1 junto à AC. Isso é dano potencial relevante:
comunique a ANPD.

### 2. Certificado A1 usado indevidamente

**O que significa.** Alguém agiu perante o Fisco em nome de um cliente. Pode ser
acesso indevido ao sistema, ou uso interno fora de propósito.

**Como se percebe.** O log tem `certificate.used` com `purpose`, `target`,
`outcome` e IP, e a rota `/certificate/usage` os lista. É a trilha que existe
exatamente para esta pergunta.

**Primeira hora.**
1. `DELETE /certificate` do CNPJ afetado, que tira o PFX do cofre.
2. Levantar os `certificate.used` do período e separar o que foi legítimo.
3. Avisar o escritório para revogar o certificado junto à AC, se houver uso que
   ele não reconheça.

**Comunicar.** Ao escritório, sempre. À ANPD, quando houver dado pessoal
envolvido no que foi feito com o certificado.

### 3. Vazamento de dado por permissão

**O que significa.** Dado fiscal alcançável por quem não deveria — RLS ausente,
policy larga, ou uma **view**, que não tem RLS e por padrão atravessa a das
tabelas de origem. Aconteceu em 25/09/2026 com `sped_invoices_for_crossref`.

**Como se percebe.** `npm run doctor`, checagem *exposição à chave anon*: ela
assume o papel `anon` e conta linhas, que é o que o PostgREST faz ao atender a
chave pública.

**Primeira hora.**
1. `revoke all on public.<objeto> from anon, authenticated;` — fecha antes de
   entender.
2. Se for view, `alter view … set (security_invoker = on)`.
3. Rodar o doctor de novo e confirmar `[ok]`.
4. Só então levantar desde quando: `created_at` do objeto, histórico de
   migrations, e o que o log do provedor ainda guarda.

**O ponto difícil.** Provar que *não* foi acessado costuma ser impossível — o
PostgREST não guarda quem leu. Escreva isso no relatório em vez de afirmar que
não houve acesso. "Não temos como saber" é a resposta honesta, e uma auditoria
distingue quem admite isso de quem inventa.

### 4. Conta de console comprometida

**O que significa.** Doppler, Supabase, Render ou GitHub. Cada um alcança o
acervo por um caminho: a chave mestra, o banco, o deploy, o código.

**Primeira hora.**
1. Trocar a senha e encerrar as sessões ativas no console afetado.
2. Ligar MFA, se ainda não estiver — ver [`CONTROLES.md`](CONTROLES.md).
3. Rotacionar **todos** os segredos que aquele console alcança. No caso do
   Doppler, isso inclui a chave mestra: siga a classe 1.
4. Conferir o histórico de deploy e de commits do período.

### 5. Perda ou corrupção de dado

**Primeira hora.**
1. Não escrever mais nada no banco afetado.
2. Restaurar num projeto **novo**, nunca por cima.
3. Conferir a restauração com `scripts/conferir-restauracao.ts`, que compara
   estrutura, fluxo de eventos e hash de projeção contra a origem.
4. Só apontar a aplicação para o restaurado depois de a conferência dizer
   `Restauração fiel`.

O procedimento completo está em [`CONTROLES.md`](CONTROLES.md), seção *Ensaio de
restauração* — e é por isso que o ensaio tem de ser feito **antes** de precisar.

## O que preservar, em qualquer classe

Antes de corrigir, copie. Corrigir apaga a evidência, e a pergunta "desde
quando" costuma chegar depois.

| Fonte | O que responde | Onde |
|---|---|---|
| `security_events` | Quem entrou, quem falhou, quem foi barrado, de onde | Banco, com HMAC de IP e de e-mail |
| `events` | Quem mudou qual número fiscal, com hash verificável | Banco, append-only |
| `certificate.used` | Todo uso de certificado, com propósito e IP | Dentro do `events` |
| Log do provedor | O resto — e **é o que expira primeiro**. Copie no primeiro dia | Render |

## Depois

Escreva o que aconteceu enquanto está fresco: o que falhou, o que detectou, o
que faltou detectar. Se o incidente não gerou nem uma checagem nova nem uma
linha de teste, ele vai acontecer de novo.

A checagem *exposição à chave anon* do doctor nasceu assim.
