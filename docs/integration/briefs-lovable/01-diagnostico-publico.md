# Brief 01 — Diagnóstico de prontidão para a reforma

> Cole este arquivo inteiro no Lovable. Ele é autocontido.

## O que estamos construindo

Uma landing page **sem login** onde um escritório de contabilidade sobe XMLs de
notas fiscais que já recebeu e descobre, em segundos, quantos dos seus
fornecedores já emitem com os campos de IBS/CBS da reforma tributária.

## Por que ela existe (leia antes de desenhar)

O público-alvo — escritórios contábeis com 20 a 300 CNPJs na carteira — em geral
**ainda não sabe que tem esse problema**. Não adianta uma landing que explica a
reforma: já existem centenas. Esta tela mostra o problema com os dados do
próprio visitante, e é isso que a torna convincente.

O momento do "ah, não é pouca coisa" é a divergência entre três números que a
API devolve: uma carteira pode estar **25% pronta em documentos e 90% pronta em
valor**, ou o contrário. Essa divergência é o argumento. **Ela precisa ser a
coisa mais visível da tela** — não uma linha numa tabela.

## Fluxo

1. Visitante cai na página. Vê o que a ferramenta faz e uma área de upload.
2. Arrasta uma pasta de XMLs (ou clica para escolher). Até **50 arquivos**, 10 MB no total.
3. Envia. Em segundos recebe o relatório, na mesma página.
4. Abaixo do relatório, um campo opcional de e-mail para receber uma cópia.

Sem cadastro, sem senha, sem etapa intermediária.

## Contrato

```
POST {VITE_AUDIT_API_URL}/reform-readiness
Content-Type: multipart/form-data
(sem cabeçalho Authorization)
```

Campos do form:

| Campo | Tipo | Obrigatório |
|---|---|---|
| `files` | arquivos, repetido | sim, 1 a 50 |
| `source` | texto | não (ex.: `"landing"`) |

O e-mail **não vai aqui**. Ele é registrado depois, numa rota própria — ver
"Depois do relatório".

Resposta `200`:

```json
{
  "report_id": "3f2a91c4-8b7e-4d1a-9c55-2e6b0f8a71d3",
  "generated_at": "2027-09-24T14:02:11.000Z",
  "totals": { "documents": 50, "parsed": 47, "rejected": 2, "duplicates": 1 },
  "documents_ready": { "total": 47, "ready": 12, "ready_pct": 25.5 },
  "items_ready":     { "total": 318, "ready": 61, "ready_pct": 19.2 },
  "value_ready":     { "total_cents": 98450000, "ready_cents": 31200000, "ready_pct": 31.7 },
  "periods": [
    { "period": "2027-07", "documents": { "total": 23, "ready": 3, "ready_pct": 13.0 } }
  ],
  "issuers": [
    { "cnpj": "11222333000181", "name": "DISTRIBUIDORA ALFA LTDA",
      "documents": { "total": 9, "ready": 9, "ready_pct": 100.0 },
      "total_cents": 1240000 }
  ],
  "issuers_truncated": false,
  "ncms": [ { "ncm": "73181500", "items": { "total": 40, "ready": 10, "ready_pct": 25.0 } } ],
  "ncms_truncated": false,
  "rejections": [
    { "filename": "nota-07.xml", "layer": 2, "reason": "schema_violation",
      "message": "Documento sem itens (grupo det)." }
  ],
  "limits": { "max_files": 50, "max_total_bytes": 10485760 },
  "persisted": { "documents": false, "summary_until": "2026-09-26T12:00:00.000Z" },
  "lead_registered": false
}
```

## Como montar a tela

### Antes do envio

Cabeçalho curto: o que é, quanto custa (nada), o que acontece com os arquivos.
Diga de forma literal e visível: **"Seus XMLs não são armazenados."** Isso é
verdade — a API devolve `persisted.documents: false` — e é o que vence a objeção
que todo contador tem. Se `persisted.summary_until` vier preenchido, diga também
que o resumo fica guardado cifrado até aquela hora, só para o envio por e-mail.

Área de upload grande, com drag-and-drop de pasta. Mostre o limite antes de a
pessoa errar: "até 50 arquivos, 10 MB no total". Ao soltar os arquivos, liste
os nomes com contagem e deixe remover algum.

Botão primário `bg-primary`, `h-control`. Enquanto processa, estado de carga
explícito — o parsing é síncrono e pode levar alguns segundos com 50 arquivos.

### O relatório

**Três cartões grandes, lado a lado, no topo.** Esta é a parte que importa:

| Cartão | Campo | Rótulo sugerido |
|---|---|---|
| 1 | `documents_ready.ready_pct` | Das suas notas |
| 2 | `items_ready.ready_pct` | Dos seus itens |
| 3 | `value_ready.ready_pct` | Do seu dinheiro |

Cada cartão: percentual grande em `font-heading`, e embaixo, menor, o absoluto
(`12 de 47 notas`). No terceiro, o absoluto em reais, formatado de `ready_cents`
e `total_cents`.

Quando os três percentuais divergirem em mais de 15 pontos, acrescente uma linha
de leitura abaixo dos cartões, por exemplo: *"Suas notas estão 25% prontas, mas
90% do valor que você movimenta já vem com IBS/CBS — a adesão está concentrada
nos seus fornecedores maiores."* Essa frase é o produto.

**Tabela por fornecedor** (`issuers`), a mais útil da página, porque é acionável
— o escritório sabe para quem ligar. Colunas: razão social, CNPJ em `font-mono`,
notas prontas / total, percentual com barra, valor total. Ordenada como veio.
Se `issuers_truncated` for `true`, avise que mostra os 50 maiores.

**Evolução por competência** (`periods`) como linha ou barras simples — mostra a
adesão subindo mês a mês, o que sugere urgência sem precisar afirmar nada.

**Por NCM** (`ncms`), tabela secundária, pode vir colapsada. `(sem NCM)` é um
valor real e um achado: destaque, não esconda.

**Rejeições** (`rejections`), se houver, em painel discreto ao final:
`filename` e `message`. Trate como achado do diagnóstico, não como erro — o
título certo é "2 arquivos não puderam ser lidos", não "Falha no envio".

### Depois do relatório

Campo de e-mail **abaixo** do relatório completo, com checkbox de consentimento.
O botão só habilita com os dois preenchidos.

Ele usa uma rota própria, e **não reenvia os arquivos**:

```
POST {VITE_AUDIT_API_URL}/reform-readiness/lead      (sem Authorization)
{
  "report_id": "<o report_id que veio no relatório>",
  "email": "contador@escritorio.com.br",
  "consent": true,
  "source": "landing"
}
```

Resposta `200`: `{ "lead_registered": true }`.

Guarde o `report_id` do relatório em memória (estado do componente) para usar
aqui. Reenviar os XMLs só para registrar um endereço dobraria o processamento e
criaria um segundo diagnóstico no funil para o mesmo visitante.

`404` significa id inexistente **ou** e-mail já registrado para aquele
diagnóstico — a API não distingue os dois de propósito. Trate como "já
enviado" e não deixe o usuário insistir.

**Nunca** condicione o relatório ao e-mail.

## Estados

| Estado | O que mostrar |
|---|---|
| Vazio | Área de upload + explicação. Sem esqueleto de tabela. |
| Carregando | Barra ou spinner, "Lendo N arquivos…". Sem porcentagem falsa. |
| `200` com `parsed: 0` | Todos os arquivos falharam: mostre as rejeições e convide a tentar de novo. Não mostre 0% como se fosse resultado. |
| `400` | `{ code: "bad_request", message }` inline — limite de forma (nenhum arquivo, mais de 50, mais de 10 MB) ou, no envio do e-mail, endereço malformado. A `message` já vem pronta para exibir. |
| `404` no envio do e-mail | Já registrado, ou `report_id` perdido. "Este relatório já foi enviado." |
| `429` com `code: "rate_limited"` | "Você fez muitos diagnósticos seguidos. Tente de novo em N segundos." Use `retry_after_seconds`. **Não é tela de upgrade.** |
| `503` com `code: "diagnostic_disabled"` | "O diagnóstico está temporariamente indisponível." |

## Não faça

- Não peça e-mail antes do resultado.
- Não reenvie os XMLs para registrar o e-mail: use `POST /reform-readiness/lead`
  com o `report_id`.
- Não recalcule percentual: use `ready_pct`.
- Não use `supabase-js` — nada aqui passa pelo Supabase deste repositório.
- Não guarde os XMLs em `localStorage` nem em lugar nenhum: a promessa da página
  é que eles não ficam.
- Não mostre CNPJ em fonte proporcional. Sempre `font-mono`.
