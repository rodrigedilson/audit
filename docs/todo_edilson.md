# TODO — Edilson

O que está na sua mão. Não é backlog de produto: é a lista do que **só você pode
decidir ou fazer**, separada do que é código.

Cada item é conferido contra o repositório e o banco antes de entrar. Os que já
foram resolvidos saem daqui — a lista só serve se encolher.

*Última conferência: 2026-09-24, sobre a `main` em `7237827` (PR #57).*

---

## 1. Antes de publicar

- [ ] **Definir `TRUST_PROXY=true` no ambiente de produção.**
      Desde o PR #57 a API **se recusa a subir** com `AUDIT_ENV=prod` sem ele, o
      que é muito melhor do que o comportamento anterior. Mas ainda é você quem
      põe a variável no Render — só que agora o erro aparece no boot, e não como
      um funil que morre em silêncio.

- [ ] **Conferir o *valor* de `CORS_ORIGINS`, não só a presença.**
      A ausência já derruba o boot em produção. O que ninguém checa é se o
      domínio listado é o certo: com o valor errado, o navegador bloqueia tudo e
      o erro aparece só no console do visitante.

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
