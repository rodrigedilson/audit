# TODO — Edilson

O que está na sua mão. Não é backlog de produto: é a lista do que **só você pode
decidir ou fazer**, separada do que é código.

Cada item é conferido contra o repositório e o banco antes de entrar. Os que já
foram resolvidos saem daqui — a lista só serve se encolher.

*Última conferência: 2026-09-25, sobre a `main` em `ed34a6b` (PR #65), com o
doctor rodado contra produção e o schema de produção lido tabela a tabela.*

---

## 0. Agora — dado fiscal aberto na internet

- [ ] **Aplicar `supabase/migrations/20260927100000_view_exposta_ao_anon.sql`.**
      (No SQL Editor do Supabase. O equivalente numerado sai em
      `scripts/sql/migracoes/` com `npm run sql:bundle`; o número muda a cada
      migration nova, então o caminho acima é o que não envelhece.)
      A view `sped_invoices_for_crossref` responde à chave anon do Supabase com
      192 notas fiscais reais: CNPJ do emitente, número, série e data. A chave
      anon é **pública por construção** — vai no pacote do frontend e qualquer
      pessoa a extrai do navegador. Conferido em produção em 25/09/2026 com um
      `GET` que devolveu `200`.

      A view é resíduo da fase anterior e nenhum código a consulta. A migration
      revoga o acesso e liga `security_invoker`; não dropa, porque a definição
      dela é a única cópia que existe.

      **Confere assim:** `doppler run --project audit --config prd -- npm run doctor`.
      A checagem *exposição à chave anon* tem de sair `[ok]`; hoje sai `[FALHA]`
      nomeando a view.

- [ ] **Decidir o destino do acervo legado.**
      Vinte e dois objetos em produção sobraram da fase anterior, e **dezoito
      têm dado** de clientes reais — notas, itens, tributos, XML. Nenhuma
      migration os cria, nenhum código os lê, e estão fora do isolamento por
      `(tenant_id, cnpj)` e de qualquer trilha. O item acima fecha o furo de
      permissão de um deles; o acervo continua lá.

      Migrar, arquivar ou apagar. Apagar dado fiscal de cliente é decisão sua.
      Inventário com contagem de linhas em
      [`seguranca/CLASSIFICACAO-DE-DADOS.md`](seguranca/CLASSIFICACAO-DE-DADOS.md).

---

## 1. Antes de publicar

- [ ] **Ligar o envio do relatório do diagnóstico por e-mail (Doppler `prd`).**
      O código está no ar desde o PR #65, e o SQL do passo 31 já está aplicado.
      Sem estes segredos o diagnóstico funciona, o lead é gravado e a resposta
      diz `email_sent: false` — a tela avisa que o envio automático ainda não
      está ligado. O envio é por SMTP, então serve o servidor do seu domínio.

      ```bash
      # smtps:// na 465 ou smtp:// na 587; o @ do usuário vira %40.
      doppler secrets set MAIL_SMTP_URL='smtps://diagnostico%40seu-dominio.com.br:SENHA@smtp.seu-provedor.com:465' --project audit --config prd
      doppler secrets set MAIL_FROM='Diagnóstico <diagnostico@seu-dominio.com.br>' --project audit --config prd
      doppler secrets set PUBLIC_API_URL=https://SUA-API.onrender.com --project audit --config prd
      doppler secrets set REPORT_ENCRYPTION_KEY="$(openssl rand -base64 48)" --project audit --config prd
      doppler secrets set IP_HASH_SECRET="$(openssl rand -base64 48)" --project audit --config prd
      ```

      - As três primeiras vão juntas: a API não sobe com só parte delas, porque
        o e-mail leva o link de remoção, que usa a URL pública.
      - Muitos provedores pedem **senha de aplicativo**, e não a senha da conta.
      - **SPF e DKIM** do domínio do `MAIL_FROM` precisam autorizar o servidor
        SMTP, ou o relatório cai em spam.
      - Ao ligar o `IP_HASH_SECRET`, a quota diária de cada IP recomeça do zero,
        uma vez.
      - Conferir com `doppler run --project audit --config prd -- npm run doctor`:
        a linha `e-mail do diagnóstico` passa de aviso para ok. Detalhes em
        `docs/setup/SEGREDOS.md`, seção E-mail do diagnóstico.

- [ ] **Tirar `http://localhost:5173` do `CORS_ORIGINS` de produção.**
      Hoje o valor em `prd` é `http://localhost:5173,https://sped-genius-hub.vercel.app`.
      O domínio do front está certo; o `localhost` sobra, e libera a API de
      produção para qualquer página servida na porta 5173 da máquina de quem a
      abrir.

      ```bash
      doppler secrets set CORS_ORIGINS=https://sped-genius-hub.vercel.app --project audit --config prd
      ```

- [ ] **Termo de uso: guarda do A1 e coleta agendada (ADR-007).**
      Guardar o certificado e ligar a coleta agendada autoriza o sistema a agir
      em nome da empresa. O termo precisa dizer isso em palavras que um contador
      entende, antes do primeiro cliente ligar a opção.

- [ ] **Ordem de deploy: API antes do frontend.**
      A tela de preço esconde toda feature sem rótulo — comportamento correto.
      Se o front subir contra uma API sem `feature_labels`, os planos aparecem
      **sem nenhuma funcionalidade listada**, sem mensagem de erro.

---

## 2. Decisões comerciais em aberto

- [ ] **Calibrar a escada de preço.**
      Hoje: `1:0% · 101:15% · 301:30% · 601:40% · 1001:50%`, mínimo R$ 150,00,
      teto R$ 25.000,00. Continuam sendo **hipótese de teste de preço**, como o
      briefing diz — e agora o `doctor` avisa isso em voz alta.
      Desde o PR #57 a escada é versionada por `effective_from`: agendar uma nova
      é inserir a escada **inteira** com data futura, não trocar degraus.

- [ ] **Decidir o que fazer com carteiras de 500 a 1.500 CNPJs.**
      O buraco que nem as faixas nem o teto cobrem: 1.200 CNPJs de Simples
      Híbrido custam **R$ 23.780/mês** e ficam abaixo do teto, então ele não os
      toca. Baixar o teto até alcançá-los machucaria o ICP — a 300 CNPJs de Lucro
      Real a fatura já é R$ 24.030. O mecanismo é
      `subscriptions.cap_cents_override`, negociado em contrato.

- [ ] **Não passar de 50% no desconto marginal sem entender o preço disso.**
      Não é preferência: é a condição que mantém a fatura monotônica. Acima de
      50%, acrescentar um CNPJ caro passa a **baixar** a conta. Degressão maior
      tem de sair pelo teto, não pela faixa.

---

## 3. Dívida técnica confirmada

- [x] ~~**`projection_snapshots` órfã.**~~ Removida pela migration
      `27-remove-projection-snapshots.sql`; não existe mais em produção. O texto
      abaixo fica só para registro do que era.

      Existia desde a primeira migration
      e é citada só no `environment-doctor`; nada em `src/` lê ou escreve nela.
      Ou passa a ser usada, ou sai — hoje sugere um cache que não existe.

- [ ] **`sped-genius-hub` → apagar `feature/backend-implementation`.**
      Branch de 02/03/2026, 106 commits atrás da `main`. O
      `checkpoint/CHECKPOINT.md` ainda a cita como se fosse a linha de trabalho.

---

## 4. Riscos do briefing que continuam abertos

- [ ] **Fonte normativa do monofásico e da ST precisa de revisão fiscal humana.**
      O briefing registra que parte das normas não foi conferida em texto
      oficial. NCM classificado errado é literalmente a reclamação que o produto
      usa como contraposicionamento contra o e-Auditoria.

- [ ] **ISO 27001 ou SOC 2.** O `CONTROLES.md` já descreve os controles e os
      suboperadores, o que é meio caminho. Falta a decisão de certificar:
      custodiamos certificado A1, escritório grande pergunta antes de entregar o
      dele, e a Taxcel já vende SOC 2 Type 2 a partir do plano Pro.

- [ ] **Ensaio de restauração de backup.** A única lacuna cuja falha é
      irreversível. O Supabase faz backup; ninguém nunca restaurou, e backup não
      testado é hipótese. A ferramenta de conferência já existe e foi exercitada
      contra uma cópia de 86.312 eventos — a cópia fiel passa e as três
      adulterações testadas foram todas acusadas. Procedimento em
      [`seguranca/CONTROLES.md`](seguranca/CONTROLES.md), seção *Ensaio de
      restauração*: restaurar num projeto **novo**, rodar
      `scripts/conferir-restauracao.ts`, guardar a saída com a data, apagar o
      projeto. Tem de dizer `Restauração fiel`.

- [ ] **MFA em Doppler, Supabase, Render e GitHub.** Quem entra em qualquer um
      alcança o acervo inteiro por caminhos diferentes: o Doppler tem a chave
      mestra do cofre, o Supabase tem o banco e a emissão de token, o Render tem
      o deploy, o GitHub tem o que vai a produção. **TOTP ou chave física; SMS
      não conta** — é vulnerável a troca de chip. Registre data e método.
      Nenhum código alcança isso, e por isso não há checagem no doctor: uma que
      dissesse "ok" sem verificar seria pior que a lacuna.

- [ ] **Revisão de acesso**, na mesma sentada do MFA — uma sem a outra vale
      pouco. Liste quem tem acesso aos quatro consoles, remova quem não precisa,
      anote a data. `GET /v1/users` lista o acesso ao **produto**, não à
      infraestrutura.

- [ ] **Decidir retenção e descarte.** O event log é append-only por projeto, e
      é o que sustenta a afirmação de que o número deriva daqueles documentos.
      Um pedido de exclusão que alcance o `actor` de um evento não se resolve com
      um `delete`. Pseudonimizar o autor, segregar o dado pessoal fora do log, ou
      aceitar a retenção e justificá-la são escolhas com consequência diferente
      para a trilha de defesa — e a escolha é sua, não minha.

---

## 5. O que sobrou da análise competitiva (é copy, não código)

- [ ] **"Não substituímos nada" na primeira dobra do site.** A Solutio
      transformou co-existência em argumento de venda. Nosso caso é mais forte —
      não emitimos DAS, não trocamos o ERP, lemos o XML que já existe — e está
      enterrado no briefing como "fora de escopo por decisão".

- [ ] **Nichar o go-to-market por setor.** O diferencial de monofásico/ST só dói
      em farma, autopeças, bebidas, combustível e mercado. "Saúde do cadastro" é
      nome de engenheiro; "quanto a sua farmácia paga de PIS/Cofins que não
      devia" é nome de cliente.

- [ ] **Converter o contraposicionamento contra o e-Auditoria em promessa
      positiva.** Copy construída sobre reclamações de terceiros no Reclame Aqui
      é exposição jurídica desnecessária. "Cancele em um clique, sem ligar para
      ninguém" diz o mesmo e é verificável no produto.

- [ ] **Levar gente até o diagnóstico.** Ele existe e funciona; falta tráfego. A
      Constanzo é o retrato do ICP: 1.200+ CNPJs, compra mídia paga, e nenhuma
      linha sobre a reforma.

---

## Resolvido desde a primeira versão desta lista

- ~~Telas públicas com `fetch` cru~~ — passam pelo `auditApi`
  (`sped-genius-hub`, `fix/telas-publicas-pelo-cliente`). Não era só
  inconsistência: montavam a URL sem o `/v1`, e em produção a calculadora e o
  diagnóstico recebiam 401.
- ~~Erro de TypeScript no `encodingDetector.ts`~~ — escondia um bug: todo SPED
  era lido como UTF-8, e o de Latin-1 perdia os acentos. Corrigido no mesmo PR.
- ~~`TRUST_PROXY=true` em produção~~ — gravado no Doppler `prd`; a API recusa
  subir em prod sem ele (PR #57).
- ~~`TRUST_PROXY` falhando em silêncio~~ — a API agora recusa subir em prod sem
  ele (PR #57).
- ~~Limite de requisições nas rotas públicas~~ — login 5/min e 20/h, calculadora
  30/min, `/plans` 60/min (PR #57).
- ~~Escada de preço sem versionamento~~ — `effective_from` (PR #57).
- ~~`gh pr create` como pendência~~ — virou decisão: PR manual nos dois
  repositórios, com a URL de comparação.
- ~~Mensagem de erro ilegível na superfície pública~~ — `400` com frase pronta,
  em vez do vocabulário do pipeline (PR #54).

## Fora da lista porque já está no ar

Faixas de volume com teto, diagnóstico público com lead sem reprocessamento,
comprovante de integridade, rótulos de feature vindos do servidor — todos
verificados contra a API rodando.
