# Mapa de telas — painel do escritório

> **Para quem é este documento:** quem constrói o frontend `audit-frontend` no
> Lovable. Descreve telas, estados e a rota de API que alimenta cada uma.
>
> Fonte da verdade do contrato: [`docs/api/openapi.yaml`](../api/openapi.yaml).
> Identidade visual: [`docs/integration/FRONTEND.md`](FRONTEND.md) e
> `design-system/lovable/`. Ondas em [`docs/product/BRIEFING-SAAS-FISCAL.md`](../product/BRIEFING-SAAS-FISCAL.md).

## Princípios que valem para todas as telas

1. **O número sempre vem com a sua procedência.** Onde aparece um valor apurado,
   aparece também o hash da projeção e o link para a memória de cálculo. É o
   produto: o contador não calcula, ele audita — e precisa poder defender o
   número.
2. **Ação de escrita mostra o que foi gravado.** Toda resposta de escrita traz
   `event_seq` e `projection_hash`; a tela confirma com "registrado no evento
   #N", não com um toast genérico.
3. **Rejeição não é erro de sistema.** Um `422` com `layer` e `reason` é
   informação fiscal: mostre a camada, o motivo em PT-BR e o `suggested_fix`
   quando houver. "Erro ao salvar" desperdiça o melhor do produto.
4. **Nada de IA escrevendo sozinha.** Sugestão de agente aparece como proposta,
   com botão de aceitar e a citação da evidência (`event_seq`). Nunca aplicada
   automaticamente.
5. **Light-only, verde `#365D5A` só em CTA/foco, controles 32/36/40px, raio
   6px.** Ver FRONTEND.md — os arquivos de `design-system/lovable/` substituem
   `index.css` e `tailwind.config.ts` do template.

## Telas da Onda 2 (API pronta)

### 1. Login
`POST /v1/auth/login` → `{ access_token, expires_in, tenant }`

Campos e-mail e senha. Erro sempre genérico ("E-mail ou senha inválidos") — a
API não distingue os casos de propósito, e a tela não deve inventar a distinção.
Guardar o token e o `tenant` retornado; o painel abre já sabendo o escritório.

### 2. Carteira de CNPJs — tela inicial
`GET /v1/clients?page&page_size&regime&status`

DataTable, uma linha por CNPJ: razão social, CNPJ formatado, regime (badge),
estado da competência corrente (badge: aberta / apurada / conciliada /
confirmada), nº de documentos, issues abertas, crédito em risco, próximo prazo.

- Filtros: regime e estado. Busca por razão social ou CNPJ.
- Vazio: "Nenhum CNPJ cadastrado" + CTA **Cadastrar empresa** (só para `owner`).
- Ordenação padrão: razão social. A carteira é o lugar de trabalho diário do
  escritório — priorize densidade de informação sobre espaço em branco.
- `open_issues`, `credit_at_risk_brl` e `next_deadline` vêm zerados/nulos até as
  Ondas 5 a 8. Renderize a coluna, não esconda: o dado chega sem mudar a tela.

### 3. Cadastro de empresa
`POST /v1/clients` — **somente `owner`**

Campos: `cnpj` (14 dígitos, sem máscara no envio — pode mascarar na tela),
`legal_name`, `trade_name`, `regime` (select: MEI, Simples integrado, Simples
híbrido, Lucro Presumido, Lucro Real), `uf`, `municipality_ibge`, `cnae_primary`.

- `403` com "já está cadastrado": mostre que o CNPJ já está na carteira e
  ofereça abrir o cliente. Cadastrar de novo cobraria duas vezes pelo mesmo CNPJ.
- `400` de validação: destaque o campo. CNPJ com máscara é recusado pela API.
- Sucesso: `201` com `event_seq` e `projection_hash`. Vá para o detalhe do
  cliente.

### 4. Detalhe do cliente
`GET /v1/clients/{cnpj}` · `GET /v1/clients/{cnpj}/periods` · `GET /v1/clients/{cnpj}/events`

Cabeçalho com razão social, CNPJ, regime e `has_certificate`. Abas:

- **Competências** — lista de `periods` (mais recente primeiro) com estado, hash
  e quem confirmou. CTA **Abrir competência** (`POST .../periods`, `accountant`
  ou `owner`). Competência `confirmed` é terminal: sem botão de editar — a saída
  é retificação, que entra na v0.3 do contrato.
- **Certificado** — ver tela 5.
- **Trilha** — `GET .../events`, paginado por `after_seq`, filtrável por
  `action`. Uma linha por evento: seq, data, ação, actor e payload expansível.
  Inclua os `output.rejected`: é onde o contador vê o que foi recusado e por quê.
- **Cadastro** — `PATCH /v1/clients/{cnpj}` (`owner`): nome fantasia, regime com
  `regime_effective_from` (o regime muda com vigência, não retroativamente) e
  status ativo/inativo. Deixe claro que inativar afeta a fatura.

### 5. Cofre de certificados A1
`GET|PUT|DELETE /v1/clients/{cnpj}/certificate` · `GET .../certificate/usage` · `GET /v1/certificates/expiring`

- **Sem certificado:** upload (`PUT`, multipart `pfx` + `password`), **somente
  `owner`**. Avise que o arquivo é cifrado e que a senha **não** é guardada.
- **Com certificado:** titular, emissor, serial, validade, `days_to_expiry`
  (badge de alerta abaixo de 30 dias), quem guardou e quando, último uso e
  contagem de usos. **A API nunca devolve o PFX** — não existe botão de baixar.
- **Log de uso:** tabela de `certificate.used` com finalidade, serviço acessado,
  resultado e IP. É o diferencial sobre o concorrente: trilha de cada uso.
- **Vencendo:** widget na home com `GET /v1/certificates/expiring?days=60`. Um
  certificado vencido para a coleta de DF-e sem avisar ninguém.

### 6. Ingestão de documentos (Onda 4)
`POST /v1/clients/{cnpj}/documents` (multipart, campo `files`, até 200 por vez)

Responde **207 Multi-Status** sempre — inclusive quando tudo passou, para o
cliente ter um só caminho de parsing. O corpo traz `accepted[]` e `rejected[]`.

- **Arraste o mês inteiro.** Um arquivo com problema não interrompe o lote: 198
  notas entram e 2 aparecem em `rejected[]`.
- **Mostre a rejeição como informação fiscal**, não como falha de upload: cada
  item de `rejected[]` traz `filename`, `layer`, `reason` e `message` em PT-BR.
  As rejeições também ficam no event log, então a tela de trilha as lista.
- **Competência precisa estar aberta antes.** Documento de mês não aberto é
  recusado na camada 4 com "não foi aberta". Ofereça abrir a competência ali
  mesmo, em vez de mandar o usuário a outra tela.
- **Duplicata** (`duplicate_document`) é esperada quando o escritório sobe o
  mesmo arquivo duas vezes; trate como aviso, não como erro.

`GET /v1/clients/{cnpj}/documents?period&direction&has_reform_group`

DataTable com chave de acesso, modelo, direção (entrada/saída), emissão,
contraparte, total e um indicador de grupo UB. O filtro `has_reform_group=false`
é o **indicador de prontidão para a reforma**: são as notas que o fornecedor
ainda emite sem IBS/CBS.

`GET /v1/clients/{cnpj}/documents/{access_key}`

Documento item a item, com `legacy_taxes` (ICMS, IPI, PIS, COFINS) e
`reform_taxes` (CST-IBS/CBS, cClassTrib, IBS-UF, IBS-Mun, CBS) **lado a lado**.
Esta é a tela que materializa o diferencial: os dois sistemas no mesmo item.
Valores vêm em centavos inteiros — divida por 100 na apresentação, nunca antes.

`POST /sync`, `/sped`, `/bank-statements` respondem **501** por enquanto e
apontam o upload manual: enfileirar sem consumidor deixaria o escritório
esperando um job que nunca sai de `queued`.

### 7. Saúde do cadastro de itens (Onda 5)
`GET /v1/clients/{cnpj}/items?health` · `PUT .../items/{item_id}/classification` · `GET .../items/health`

É o diferencial #1: o erro nasce no cadastro do item e contamina toda nota
emitida com ele. A tela tem de deixar essa relação óbvia.

- **A lista já vem na ordem de trabalho:** pior saúde primeiro e, dentro dela, o
  que contamina mais notas. Não reordene por nome por padrão.
- **`documents_affected` é a coluna que justifica o produto.** Um item com
  `health: error` e 340 notas afetadas é uma prioridade diferente de um com 2.
- **`health_reasons` vem em PT-BR, pronto para exibir.** Cada `issue` da resposta
  de classificação traz `reason`, `severity`, `field`, `message` e
  `suggestedFix` — mostre o `suggestedFix`, é a ação concreta.
- **Classificação incompatível é registrada, não bloqueada.** O contador pode
  precisar classificar exatamente como está no documento do fornecedor; a tela
  mostra o erro e deixa salvar. Bloquear faria o escritório resolver fora do
  sistema, sem trilha.
- **`effective_from` é vigência, não competência de trabalho.** Reclassificar não
  reescreve o passado: cria uma vigência nova. Deixe claro na tela que a
  classificação antiga continua valendo para os meses anteriores.
- **Vigência em competência confirmada é recusada** com `422` e camada 6 —
  mudaria uma apuração fechada. Ofereça a vigência do mês seguinte.
- **`reference_tables_loaded: false`** → mostre o `notice` da resposta com
  destaque. Sem as tabelas oficiais, "nenhum erro" não quer dizer "correto", e
  esconder isso daria falsa segurança ao escritório.

### 8. Apuração dual (Onda 6)
`POST /assessments/{period}` · `GET /assessments/{period}` · `GET .../trace` · `POST .../adjustments` · `POST .../confirm`

É o diferencial #2: os dois sistemas lado a lado, nota a nota.

- **Mostre `debitsCents`, `potentialCreditsCents`, `creditableCents` e `dueCents`
  como quatro coisas diferentes.** Não colapse em "total": os dois primeiros
  saem dos documentos e são certos; os dois últimos dependem de norma.
- **`dueCents: null` não é erro nem zero.** Renderize como *"não determinável"*
  com o motivo de `not_computable` ao lado. Um `—` sem explicação faria o
  contador achar que é bug; um `0` seria mentira.
- **`coverage` é o indicador de prontidão**: quantos itens já trazem o grupo
  IBS/CBS. Bom lugar para uma barra de progresso na home do cliente.
- **`GET .../trace` é a memória de cálculo.** Uma linha por item e por tributo,
  com chave de acesso, base, alíquota e valor. É o que o contador apresenta —
  deixe filtrar por tributo e por documento, e permita exportar.
- **Ajuste não sobrescreve.** Os totais continuam os do documento e o ajuste
  aparece à parte: a diferença entre o apurado e o ajustado é informação, não
  ruído. Justificativa é obrigatória.
- **O `confirm` exige o `projection_hash` que a tela recebeu.** Se divergir vem
  `422` com `verification_mismatch` — significa que algo mudou entre a
  conferência e o clique. **Não reenvie o hash novo automaticamente**: recarregue
  a apuração e faça o usuário revisar. Reenviar sozinho anularia a proteção.
- **Confirmada é terminal.** Sem botão de editar; a correção é retificação.

### 9. Trilhas de auditoria e Book de fechamento (Onda 7)
`GET /v1/audit-trails` · `GET /audit-trails/{period}` · `POST|GET /books/{period}` · `GET /books/{period}/{book_id}/download`

É o diferencial #3 e o primeiro entregável que sai do escritório para o cliente
final.

- **`GET /v1/audit-trails` é o catálogo e não depende de competência.** Use-o na
  página de metodologia e no material de venda. A lista é o que o produto
  confere de fato — não repita a expressão "as verificações que a RFB faz", que
  é do concorrente e não descreve esta lista.
- **`not_applicable` não é `passed`, e a diferença é o produto.** Significa *não
  conferido*: a tabela oficial de códigos não estava carregada. Renderize em cor
  de aviso, com o texto "não verificado", nunca em verde e nunca junto com os
  aprovados. Quando `reference_tables_loaded` vem `false`, mostre um banner fixo
  no topo do relatório.
- **`issuesCount` é o total; `issues` é uma amostra de até 25.** Mostre o número
  de `issuesCount` no cabeçalho da trilha e leve ao drill-down — nunca conte o
  tamanho do array.
- **`amountAtStakeCents` é o número que vende.** Vem por trilha e somado em
  `summary`. É o valor das notas já emitidas que carregam o erro, não uma multa
  estimada: não rotule como "multa" nem como "risco fiscal em reais".
- **`POST /books/{period}` é síncrono e devolve `201`** com os metadados. Exige a
  competência apurada; competência apenas aberta vem `422` com camada 4. Gerar o
  Book de uma competência **confirmada** é permitido — é o caso de uso.
- **O download não regera o PDF.** Os bytes ficam guardados, e é isso que
  permite ao contador mostrar depois o arquivo exato que enviou, mesmo que uma
  regra mude. Não ofereça "atualizar este Book": gere outro, e a lista mantém os
  dois.
- **Confira o `X-Book-SHA256`.** O cabeçalho traz o SHA-256 do arquivo; vale
  exibi-lo na tela ao lado do botão de download, para o escritório poder repassar
  ao cliente.
- **`audience: business_owner` muda o texto e tira a memória de cálculo.** Deixe
  os dois botões explícitos ("versão do contador" / "versão do cliente"), porque
  são documentos diferentes com o mesmo hash.
- **`white_label` é entitlement de plano** (Lucro Presumido para cima).
  Desabilite o controle nos planos abaixo e diga por quê, em vez de esconder.

### 10. Contra-apuração e calendário (Onda 8)
`POST|GET /clients/{cnpj}/fisco-assessments/{period}` · `GET /v1/deadlines`

É o diferencial #5 e o produto central de 2027: na apuração assistida o Fisco
propõe o número e o silêncio do contribuinte vale como concordância.

- **O upload é CSV com layout nosso, não da RFB.** Mostre o cabeçalho esperado
  na própria tela de upload, e deixe baixar um modelo. O formato oficial ainda
  está em piloto; quando sair, o `source` muda e a tela não.
- **`line_level: false` é o aviso mais importante da tela.** Proposta só com
  totais não foi comparada nota a nota, e zero divergência de item ali **não**
  significa que as notas conferem. Banner fixo, não nota de rodapé.
- **Nunca some exposição com perda de crédito.** São três números distintos e
  cada um leva a uma ação diferente:
  - `exposureCents` — débito que o Fisco aponta e não escrituramos. **Será
    cobrado.**
  - `creditLossCents` — crédito que o Fisco reconhece e não aproveitamos.
    **Dinheiro na mesa.**
  - `creditAtRiskCents` — crédito nosso que o Fisco não reconhece. **Tende a ser
    glosado.**
  Um "líquido" deixaria um milhão de cada lado se cancelar na tela, e o
  escritório concluiria que está tudo certo.
- **`probableCause` é hipótese, não diagnóstico.** Rotule como *"causa
  provável"*. O sistema vê duas listas de números; a razão real pode ser erro
  nosso, erro do Fisco, documento cancelado ou nota ainda não processada por um
  dos lados. Afirmar como conclusão faria o contador contestar com base errada.
- **Agrupe por causa, não por valor.** `aliquota_divergente` discute
  enquadramento; `base_divergente` discute o documento. São conversas diferentes
  com o cliente, e misturá-las na mesma lista força o contador a reclassificar
  na cabeça.
- **`differenceCents` positivo = o Fisco aponta mais.** Deixe o sinal explícito
  na coluna; um valor absoluto obrigaria a olhar `ourCents` e `fiscoCents` para
  saber de que lado está o problema.
- **`divergencesCount` é o total; a lista de itens vem cortada em 500.** Mostre
  o total no cabeçalho e leve ao drill-down.
- **Proposta nova substitui a anterior por inteiro.** Diga isso antes de
  confirmar o upload, e guarde o `reference` (nome do arquivo) visível: é o que
  permite ao contador dizer depois qual proposta recebeu e quando.

**Calendário (`GET /v1/deadlines`)** — duas listas, e elas **não podem** compartilhar
o mesmo componente:

- **`deadlines`** tem data. `nature: normativo` traz base legal e perdê-lo tem
  consequência jurídica; `nature: fato` é data que o sistema conhece (validade
  do certificado A1) e não tem base legal porque não é prazo de lei. Mostre a
  base legal ao lado do prazo normativo, sempre.
- **`pendencies`** sai do estado do sistema e **não tem data de vencimento** —
  tem `daysOpen`. Renderize como fila de trabalho ordenada por gravidade, não
  como calendário. `proposta_do_fisco_sem_resposta` é sempre crítica e merece
  destaque próprio: é o caso que o produto existe para pegar.
- **`normative_rules_loaded: false` precisa aparecer.** Lista vazia de prazos
  não é "nada a vencer", é "nada carregado". Sem esse aviso, a tela mais
  tranquilizadora do produto seria a de um sistema sem nenhum prazo cadastrado.
- `days_left` negativo é prazo vencido. Não esconda: é o que mais importa.

### 11. Assistente fiscal (Onda 9)
`GET /v1/assistant/capabilities` · `GET|POST /clients/{cnpj}/assistant/threads` · `GET|POST .../threads/{id}/messages` · `GET .../assistant/usage`

É o diferencial #6, e o contraexemplo a evitar está no briefing: assistente
genérico sem ancoragem nos dados do CNPJ compete com o ChatGPT e perde.

- **Cada afirmação é um item com suas citações, não um parágrafo.** A resposta
  vem em `claims[]`, e `kind` decide o visual:
  - `fact` sempre tem citação. Renderize as citações como chips clicáveis que
    levam ao evento, ao documento ou ao item. **Uma afirmação factual sem chip
    visível é um bug de tela** — a API nunca emite uma.
  - `explanation` é texto normativo e não cita nada. Estilo secundário, menor.
    Nunca misture os dois no mesmo bloco de texto: é o que distingue "o sistema
    apurou isto" de "a norma funciona assim".
- **`answerable: false` não é erro.** É a resposta certa quando os dados não
  respondem, e `unanswerableReason` sempre vem preenchido. Mostre o motivo com
  destaque, não como toast de falha. Vazio, esconde exatamente a informação mais
  útil.
- **`tier` muda o que o usuário pode esperar.** `1` é consulta determinística e
  reproduzível: dá para dizer "este número sai do log e o replay confere". `3`
  significaria raciocínio livre de modelo, que **não está configurado** — e
  `GET /assistant/capabilities` diz isso em `language_model_configured: false`.
  Exiba a lista de capacidades na tela de ajuda da conversa.
- **`confidence: medium` tem significado específico.** Aparece quando a resposta
  está certa e incompleta — devido não determinável, proposta do Fisco só com
  totais. Mostre o motivo junto; um selo "média" sozinho não ajuda ninguém.
- **`suggested[]` são botões, e o assistente não os aperta.** Cada item traz
  `method`, `endpoint`, `payload` e `rationale`. Renderize como ação com o
  `rationale` visível, e **confirme antes de executar**: o valor do produto é
  justamente que nenhuma IA altera número fiscal sozinha.
- **Cota por CNPJ, não por escritório.** `GET .../assistant/usage` traz `used`,
  `allowance` e `remaining`; o `201` da pergunta devolve `X-Assistant-Remaining`.
  Mostre o restante perto do campo de pergunta, antes de o usuário digitar.
- **`allowance: 0` é `403`, não `429`.** "Não contratado" e "acabou o mês" são
  telas diferentes: a primeira leva a upgrade, a segunda leva a esperar. Tratá-las
  igual manda o usuário esperar por um recurso que ele nunca teria.
- **A pergunta consome cota mesmo com resposta não respondível.** Diga isso na
  interface, para o "não sei" não parecer cobrança indevida.

### 12. Crédito em risco por fornecedor (Onda 10)
`POST /clients/{cnpj}/bank-statements` · `POST .../payment-matches` · `GET .../credits/at-risk`

É o diferencial #7, e o briefing resume o vão: "players fiscais não olham o
banco". O crédito de IBS/CBS é condicionado à extinção do tributo da etapa
anterior, e sob split payment isso acontece na liquidação — então o extrato
bancário é informação fiscal.

- **Diga na tela por que o extrato é pedido.** O contador vai estranhar um
  produto fiscal querendo o extrato dele; a frase acima é a justificativa, e sem
  ela o upload parece intrusão.
- **`statements_imported: false` é o aviso mais importante.** Sem extrato, todo
  crédito da reforma aparece condicionado por falta de pagamento identificado —
  o que é indistinguível de "o cliente não pagou ninguém". Banner fixo até o
  primeiro extrato entrar.
- **`releasedCents` em zero é o estado normal, não um bug.** O sistema não sabe
  se o fornecedor recolheu o tributo dele: essa informação é do Fisco e não tem
  fonte hoje. Explique isso onde o número aparece, senão a tela parece quebrada.
  E **não** rotule `conditioned` como "crédito garantido".
- **`state` tem cinco valores e cada um leva a uma ação diferente:**
  - `expected` — não depende de liquidação (tributo do sistema antigo, ou
    documento sem grupo UB). Não alarme.
  - `conditioned` — o estado natural do IBS/CBS. Informativo.
  - `at_risk` — condicionado **e** sem pagamento identificado há tempo. É a fila
    de trabalho: ou pagar o fornecedor, ou não aproveitar o crédito ainda.
  - `released` — só com evidência de extinção.
  - `lost` — **nunca vem do sistema.** Declarar crédito perdido é decisão do
    contador, com consequência contábil. Se a tela oferecer o botão, ele grava
    uma decisão humana, não um cálculo.
- **`reason` nunca é vazio: mostre sempre.** Um estado sem motivo é opaco, e o
  contador não tem como contestar nem confiar.
- **`confidence` do casamento precisa estar visível.** Todo casamento é
  hipótese: valor e data iguais não provam que aquele pagamento é daquela nota.
  `exact` é o único em que alguém já disse de qual nota se trata.
- **`ambiguous` é uma pendência, não um resultado.** O sistema **recusa**
  escolher entre dois documentos de igual valor, e devolve `candidates`. Essa é a
  tela em que o humano decide — e é a mais valiosa da onda, porque é onde o
  produto admite o que não sabe em vez de errar em silêncio.
- **`lines_duplicated` explica o reenvio.** Reimportar o mesmo extrato é normal
  e não dobra nada; sem mostrar esse número, `lines_imported: 0` pareceria falha.
- **`oldestUnpaidDays` é a coluna de ordenação natural** da lista de
  fornecedores, junto com `creditAtRiskCents`.
- **`emitsReformGroup` não diz que o fornecedor usa split payment.** Diz que
  algum documento dele traz o grupo IBS/CBS. Rotule como *"emite com grupo
  IBS/CBS"*; o outro texto afirmaria algo sobre a operação de terceiro.

Na **carteira** (tela 2), `credit_at_risk_brl` vem `null`, e não `0`: a listagem
não deriva o estado do crédito por cliente. Mostre um traço com link para esta
tela, nunca um zero — zero é uma afirmação.

### 13. Simulador de regime (Onda 11)
`GET /v1/simulations/methodology` · `POST|GET /clients/{cnpj}/simulations`

É o diferencial #8 e, na priorização, **funil de aquisição**: Sittax e
simuleareforma já cobrem o espaço, e o que diferencia esta é rodar sobre os
dados reais da carteira. O prazo importa — a janela de opção de regime do art.
40-D é em março de 2027.

- **A página de metodologia é parte do produto, não rodapé.** Publique
  `GET /simulations/methodology` como página própria, linkada de dentro do
  resultado. É o que o simuleareforma faz bem e o que impede o contador de
  tratar a saída como cálculo.
- **`not_modeled` vai junto do resultado, visível.** Dez itens, e o primeiro é
  IRPJ/CSLL: o simulador compara carga sobre consumo, não carga total. Esconder
  essa lista num accordion fechado é a forma mais fácil de transformar um
  simulador honesto num desonesto.
- **Três números por regime, e eles não se substituem:**
  - `directTaxMonthlyCents` — a guia. É o que os simuladores genéricos mostram.
  - `creditToB2BCustomersCents` — crédito que o cliente PJ aproveita. **Não
    reduz a guia**; é vantagem competitiva.
  - `economicCostMonthlyCents` — guia mais o desconto que o cliente PJ vai
    exigir por não ter crédito. **É este que compara regimes.** No Simples
    integrado a guia é a menor e o custo econômico pode ser o maior, e é
    exatamente essa inversão que a tela precisa deixar óbvia.
- **`workingCapitalExposureCents` merece destaque próprio.** É a tese: o impacto
  está na necessidade de capital de giro, não na DRE. Sob split payment o tributo
  sai na liquidação e não no vencimento da guia — a carga anual pode ser igual e
  o caixa, não.
- **`winner: null` é resposta, não erro.** Significa que a escolha depende de uma
  alíquota que ainda não foi publicada, e vem com `robustness: 'sensitive'`.
  Renderize como *"depende"* e leve ao mapa de sensibilidade. **Não** escolha o
  primeiro da lista para preencher o espaço.
- **`sensitivity` é o produto quando o vencedor é null.** Trinta células,
  alíquota × fração de crédito. Heatmap com o regime vencedor em cada uma
  transforma a incerteza em informação.
- **`b2bBreakevenShare` é a frase que o contador leva para a reunião:** "acima de
  X% de faturamento para PJ, sair do Simples integrado passa a valer".
- **`assumptions[].origin` muda o peso de cada linha.** `measured` veio das notas
  do cliente; `published` veio de norma, com a fonte; `provided` é premissa.
  Cores diferentes, e a fonte sempre visível. A alíquota de referência sairá como
  `provided` enquanto não houver as três (IBS-UF, IBS-Mun e CBS) publicadas.
- **A fração contra PJ é medida, e dá para substituir.** Por omissão vem das
  notas de saída com CNPJ na contraparte — é o número que o cliente não sabe
  responder de cabeça. Se o usuário informar outro, ele aparece como
  `b2b_share_override` com origem `provided`.
- **Sem documento no período vem `422`.** Mostre a mensagem: qualquer número
  seria inventado. Não ofereça "simular com dados de exemplo".
- **MEI e Lucro Real recebem `403` com o motivo.** Mostre o texto da API em vez
  de esconder o botão: o contador precisa saber *por que* não se aplica.

### 14. Planos e assinatura (Onda 3)
`GET /v1/plans` e `POST /v1/price-calculator` são **públicas** — a calculadora
vai no site, antes de qualquer contato comercial.

- Mostre `subtotal_cents`, `minimum_adjustment_cents` e `total_cents`
  separados. O ajuste de mínimo existe para ser explicado, não escondido atrás
  de um total.
- `GET /v1/subscription` traz status, fim do trial e a cotação do mês corrente.
- `POST /v1/subscription/cancel` (`owner`): **um clique, sem diálogo de
  retenção**. Mostre a mensagem que a API devolve — ela diz que os dados e a
  trilha continuam acessíveis.

### 15. Usuários e papéis
Rotas na Onda 3 (`/users`, `/invites`). Papéis já valem na API:

| Papel | Pode |
|---|---|
| `owner` | tudo: cadastro de empresa, certificado, cobrança |
| `accountant` | abrir competência, apurar, confirmar |
| `viewer` | somente leitura |

A tela deve esconder o que o papel não permite, **e** tratar o `403`: esconder
botão não é autorização.

## Telas das ondas seguintes

| Onda | Tela | Rota |
|---|---|---|

## Componentes que faltam no design system

`design-system/` hoje tem primitivos de outro domínio (ReviewCard, StepPanel,
Citation, de um assistente de requisitos regulatórios). Para este painel faltam,
em ordem de necessidade:

1. **AppShell** com sidebar montada (o `.ejr-sidebar-item` existe solto)
2. **DataTable** com ordenação, paginação, estado vazio e de carregamento
3. **Barra de filtros** (select + busca + limpar)
4. **Stat tile / KPI** para a home e o cabeçalho do cliente
5. **Tabs** para o detalhe do cliente
6. **Modal / Sheet** para cadastro e upload
7. **Timeline de eventos** para a trilha (aproveita `.ejr-citation`)
8. **Badges de estado fiscal** — reaproveite `.ejr-badge` com os estados de
   competência e de crédito
9. **Badge de trilha em quatro estados** — `passed`, `warning`, `failed` e
   `not_applicable`. O quarto **não pode** cair no mesmo visual do primeiro: é a
   diferença entre "conferido e correto" e "não conferido" 
10. **Fila de pendências**, distinta do calendário: ordenada por gravidade e com
    `daysOpen`, nunca com data de vencimento inventada
11. **Chip de citação** clicável, que abre o evento ou o documento citado — é o
    componente que sustenta a promessa do assistente
12. **Resolvedor de ambiguidade**: dois ou mais candidatos lado a lado para o
    humano escolher, com o motivo de cada um
13. **Heatmap de sensibilidade** (alíquota × fração de crédito), com o regime
    vencedor por célula — é o que substitui a resposta única quando ela não existe

Os tokens e os seis princípios não mudam.

## Contrato de erro, uma vez para todas as telas

| HTTP | Forma | Como mostrar |
|---|---|---|
| 400 | `{ code, message, details }` | erro de campo, destaque inline |
| 401 | `{ code, message }` | sessão expirada → login |
| 403 | `{ code, message }` | mensagem da API; ela explica o papel ou a duplicidade |
| 404 | `{ code, message }` | "não encontrado nesta carteira" |
| 409 / 422 | `{ rejected, layer, reason, message, details }` | **inconsistência fiscal**: mostre camada + motivo + mensagem |
| 429 | `{ code, message }` | limite do plano atingido → tela de upgrade |

O `404` é deliberadamente indistinguível entre "CNPJ não existe" e "existe em
outro escritório" — não tente inferir a diferença na tela.
