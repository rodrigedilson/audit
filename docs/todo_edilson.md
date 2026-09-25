# TODO — Edilson

O que está na sua mão. Não é backlog de produto: é a lista do que **só você pode
decidir ou fazer**, separada do que é código.

Cada item é conferido contra o repositório e o banco antes de entrar. Os que já
foram resolvidos saem daqui — a lista só serve se encolher.

*Última conferência: 2026-09-25, sobre a `main` em `ed34a6b` (PR #65).*

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

- [ ] **`sped-genius-hub` → `src/features/sped-upload/utils/encodingDetector.ts:44`**
      Erro de TypeScript pré-existente (`Uint8Array` vs `Buffer`). O build passa
      porque o Vite não roda o typecheck.

- [ ] **As duas telas públicas do Lovable usam `fetch` cru.**
      `DiagnosticoReforma.tsx` e `CalculadoraPreco.tsx`: zero uso de `auditApi`.
      Defensável em rota sem autenticação, mas inconsistente com as outras 14
      telas — e é o cliente que centraliza tradução de erro e token.

- [ ] **`projection_snapshots` continua órfã.** Existe desde a primeira migration
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
