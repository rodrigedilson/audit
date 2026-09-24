# TODO — Edilson

O que está na sua mão. Não é backlog de produto: é a lista do que **só você pode
decidir ou fazer**, separada do que é código.

Cada item foi conferido contra o repositório e o banco em 2026-09-24. Os que já
foram resolvidos saíram daqui.

---

## 1. Antes de publicar (bloqueia as telas públicas)

- [ ] **`TRUST_PROXY=true` em produção.**
      Atrás do proxy do Supabase/Vercel/Cloudflare, `request.ip` é o IP do proxy.
      Sem isso, os primeiros visitantes consomem a cota de 20 diagnósticos/dia de
      **todo mundo**, e o funil morre em silêncio — ninguém vê erro, a página só
      passa a responder 429 para estranhos. O padrão é `false` de propósito:
      ligado sem proxy na frente, permite forjar IP por cabeçalho.

- [ ] **`CORS_ORIGINS` com o domínio real do front.**
      Sem ele o navegador bloqueia tudo, e o erro aparece só no console do
      visitante. Testei com `https://sped-genius-hub.vercel.app` e o preflight
      responde 204 corretamente — falta o valor de produção.

- [ ] **Ordem de deploy: API antes do frontend.**
      A tela de preço esconde toda feature sem rótulo (que é o comportamento
      certo). Se o front subir contra uma API sem `feature_labels`, os planos
      aparecem **sem nenhuma funcionalidade listada**, sem mensagem de erro.

- [ ] **Saber que `PUBLIC_DIAGNOSTIC_ENABLED=false` existe.**
      Killswitch do diagnóstico público. A rota é anônima e o parsing de XML é
      síncrono; se virar vetor de carga, é uma variável, não um rollback.

---

## 2. Decisões comerciais em aberto

- [ ] **Calibrar a escada de preço.**
      Hoje no banco: `1:0%  101:15%  301:30%  601:40%  1001:50%`, mínimo
      R$ 150,00, teto R$ 25.000,00. Os valores de `plans` continuam sendo
      **hipótese de teste de preço**, como o briefing diz — não benchmark. Mudar
      é `update`, não deploy.

- [ ] **Decidir o que fazer com carteiras de 500 a 1.500 CNPJs.**
      É o buraco que nem as faixas nem o teto cobrem: 1.200 CNPJs de Simples
      Híbrido custam **R$ 23.780/mês** e ficam abaixo do teto, então ele não os
      toca. Baixar o teto até alcançá-los machucaria o ICP — a 300 CNPJs de Lucro
      Real a fatura já é R$ 24.030. O mecanismo para esses casos é
      `subscriptions.cap_cents_override`, negociado em contrato, e ele existe
      justamente para isso.

- [ ] **Revisar o teto de 50% no desconto marginal, se algum dia quiser passar
      dele.** Não é preferência: é a condição matemática que mantém a fatura
      monotônica. Acima de 50%, acrescentar um CNPJ caro passa a **baixar** a
      conta. Degressão maior tem de sair pelo teto, não pela faixa.

---

## 3. Dívida técnica conhecida

- [ ] **`src/features/sped-upload/utils/encodingDetector.ts:44`** — erro de
      TypeScript pré-existente (`Uint8Array` vs `Buffer`). Não é de nenhuma tela
      nova; o build passa porque o Vite não roda o typecheck.

- [ ] **As duas telas públicas do Lovable usam `fetch` cru**
      (`DiagnosticoReforma.tsx`, `CalculadoraPreco.tsx`: zero uso de `auditApi`,
      dois `fetch` cada). Defensável em rota sem autenticação, mas inconsistente
      com as outras 14 telas, que passam pelo cliente — e é o cliente que
      centraliza tradução de erro e token.

- [ ] **`projection_snapshots` está órfã.** A tabela existe desde a primeira
      migration e é citada só no `environment-doctor`; nada em `src/` lê ou
      escreve nela. Ou passa a ser usada, ou sai — hoje ela sugere um cache que
      não existe.

- [ ] **`gh pr create` não funciona** nesta conta (não é colaborador). `push`
      funciona; o PR continua manual.

---

## 4. Riscos do briefing que continuam abertos

- [ ] **Fonte normativa do monofásico e da ST precisa de revisão fiscal humana.**
      O briefing registra que parte das normas não foi conferida em texto oficial.
      NCM classificado errado é literalmente a reclamação que o produto usa como
      contraposicionamento contra o e-Auditoria — errar aqui é pior do que não
      entregar.

- [ ] **ISO 27001 ou SOC 2 como pré-requisito comercial.** Custodiamos
      certificado A1. Escritório grande vai perguntar antes de entregar o dele, e
      a Taxcel já vende SOC 2 Type 2 a partir do plano Pro.

---

## 5. O que sobrou da análise competitiva (não é código)

Os quatro insights que viravam backend estão entregues e no ar. O resto é
posicionamento:

- [ ] **"Não substituímos nada" na primeira dobra do site.** A Solutio
      transformou co-existência em argumento de venda. Nosso caso é mais forte —
      não emitimos DAS, não trocamos o ERP, lemos o XML que já existe — e está
      enterrado no briefing como "fora de escopo por decisão". Remove a objeção
      mais cara antes de ela aparecer.

- [ ] **Nichar o go-to-market por setor.** O diferencial de monofásico/ST só dói
      de verdade em farma, autopeças, bebidas, combustível e mercado. "Saúde do
      cadastro" é nome de engenheiro; "quanto a sua farmácia paga de PIS/Cofins
      que não devia" é nome de cliente.

- [ ] **Converter o contraposicionamento contra o e-Auditoria em promessa
      positiva.** Construir copy sobre reclamações de terceiros no Reclame Aqui é
      exposição jurídica desnecessária. "Cancele em um clique, sem ligar para
      ninguém" diz a mesma coisa e é verificável no produto.

- [ ] **Usar o diagnóstico como isca, não como página parada.** Ele existe e
      funciona; o que falta é levar gente até ele. A Constanzo é o retrato do
      ICP: 1.200+ CNPJs, compra mídia paga, e nenhuma linha sobre a reforma.

---

## Fora da sua lista

O que **não** está aqui porque já foi entregue e verificado contra a API rodando:
faixas de volume com teto, diagnóstico público com lead sem reprocessamento,
comprovante de integridade, rótulos de feature vindos do servidor, e mensagens de
erro legíveis na superfície pública.
