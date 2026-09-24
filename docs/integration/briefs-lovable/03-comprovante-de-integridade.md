# Brief 03 — Comprovante de integridade da competência

> Cole este arquivo inteiro no Lovable. Ele é autocontido.
> **Esta tela exige login.**

## O que estamos construindo

Uma página que emite o comprovante de uma competência (mês fiscal) de um CNPJ:
qual apuração foi fechada, sobre quantos documentos, e a prova criptográfica de
que a trilha continua íntegra.

## Por que ela existe

O produto vende uma promessa difícil de demonstrar: *o número que você entregou
ao Fisco é defensável, e dá para provar*. Essa prova já existia na API, mas
escondida atrás de um `POST` que ninguém chamaria por conta própria.

Este é o entregável: a página que o escritório **mostra ao cliente dele**. É o
precursor em JSON do Book de fechamento em PDF.

## Contrato

```
GET {VITE_AUDIT_API_URL}/clients/{cnpj}/periods/{period}/proof
Authorization: Bearer <token>
```

`cnpj` com 14 posições sem máscara (pode ter letras — CNPJ alfanumérico é válido
desde 31/07/2026). `period` no formato `YYYY-MM`.

```json
{
  "cnpj": "12345678000195",
  "period": "2027-08",
  "state": "confirmed",
  "verified_at": "2027-09-24T14:39:40.621Z",
  "ok": true,
  "replayed_hash": "7b8ac5146a7ed033a37b422aafbf0e0949ab4ddc32a78b6227359a81c08e030c",
  "stored_hash": "7b8ac5146a7ed033a37b422aafbf0e0949ab4ddc32a78b6227359a81c08e030c",
  "confirmed_hash": "e468e8f83a9c051c9c41389e4c160f508cccb5d5f818d507c5bbf824645e3b4d",
  "confirmed_hash_reproduced": true,
  "confirmed_at": "2027-09-10T18:22:04.000Z",
  "confirmed_by": "a1b2c3d4-...",
  "rectifies": null,
  "rectified_by": null,
  "last_event_seq": 142,
  "events_in_period": 87,
  "total_events": 143,
  "documents": { "inbound": 312, "outbound": 45, "total": 357 }
}
```

## O que cada campo significa (importa para desenhar)

**`state`** — estado da competência: `open` (aberta), `assessed` (apurada),
`reconciled` (conciliada), `confirmed` (confirmada). Só `confirmed` é definitivo.

**`ok`** — a projeção de agora fecha com o replay do log. Pega defeito de
cálculo. É uma checagem de saúde, não a prova forte.

**`confirmed_hash_reproduced`** — **a prova forte, e o coração da tela.** O hash
foi gravado no log no instante em que o contador confirmou a apuração.
Reproduzi-lo hoje exige reprocessar os eventos anteriores àquele instante. Se
alguém alterou, removeu ou acrescentou evento no caminho, ele não volta a bater.

Três valores possíveis, e os três dizem coisas diferentes:

| Valor | Significado | Como mostrar |
|---|---|---|
| `true` | A apuração confirmada continua reproduzível. | Verde, afirmativo |
| `false` | **A trilha foi adulterada.** | Vermelho, alarmante |
| `null` | A competência ainda não foi confirmada — não há o que reproduzir. | Neutro, informativo |

`null` **não** é erro nem "pendente de verificação". É a ausência do fato.

**`confirmed_hash` vs `replayed_hash`** — o primeiro é o hash do momento da
confirmação; o segundo é o de agora, que inclui eventos posteriores. Eles
divergirem é normal e esperado. Não compare os dois na tela.

**`rectifies` / `rectified_by`** — quando preenchidos, esta competência retifica
outra ou foi retificada. A original nunca é alterada; a retificação abre uma
competência vinculada. Mostre como link para a outra competência.

## Como montar a tela

### Cabeçalho — o veredito

Um painel `rounded-panel` grande, a primeira coisa que se vê. O estado vem de
`confirmed_hash_reproduced`, não de `ok`:

- **`true`** — ícone de confirmação, `text-primary`, e a frase:
  *"A apuração de agosto/2027 confirmada em 10/09/2027 continua íntegra. O hash
  aprovado foi reproduzido a partir do registro de eventos."*
- **`false`** — fundo de alerta, e a frase sem eufemismo:
  *"O registro de eventos desta competência foi alterado depois da confirmação.
  O número apurado não pode ser considerado defensável até que isto seja
  investigado."* Não amenize: a página existe para detectar exatamente isto.
- **`null`** — neutro: *"Competência ainda não confirmada. O comprovante
  definitivo é emitido no fechamento."*

Ao lado, os identificadores: CNPJ (`font-mono`), competência, `state` como badge.

### Corpo

**Documentos** (`documents`) — três números: entradas (`inbound`), saídas
(`outbound`), total. Rotule em português; "inbound/outbound" não significa nada
para um contador.

**A trilha** — `events_in_period` (eventos nesta competência) e `total_events`
(no CNPJ inteiro), com `last_event_seq`. Uma frase simples resolve:
*"87 eventos registrados nesta competência, de 143 no total deste CNPJ."*

**Os hashes** — em bloco `font-mono`, com botão de copiar. Sempre exiba
completos, nunca truncados: um hash pela metade não serve de prova, que é a
única razão de ele estar na tela. Rotule cada um:

| Campo | Rótulo |
|---|---|
| `confirmed_hash` | Hash aprovado na confirmação |
| `replayed_hash` | Hash reprocessado agora |
| `stored_hash` | Hash registrado |

**Confirmação** — `confirmed_at` formatado em pt-BR e `confirmed_by`. Se houver
`rectifies` ou `rectified_by`, um aviso com link para a competência vinculada.

**Rodapé** — `verified_at`: *"Verificado em 24/09/2027 às 11:39."* Deixe claro
que a verificação é feita a cada carregamento, não cacheada — é o que dá valor
ao documento.

Inclua um botão de imprimir com `@media print` limpo: esta página vai virar PDF
anexado a e-mail para o cliente final.

## Estados

| Estado | O que mostrar |
|---|---|
| Carregando | Esqueleto do painel. A chamada reprocessa o log e pode levar segundos em CNPJ com muito evento. |
| `404` | "Competência não encontrada para este CNPJ." **Não** tente distinguir "não existe" de "é de outro escritório" — a API não distingue de propósito, e inferir na tela vazaria informação. |
| `400` | Competência malformada (fora de `YYYY-MM`). |
| `409` com `code: "EVENT_STORE_CORRUPTED"` | **Trate com a mesma gravidade do `confirmed_hash_reproduced: false`.** Significa que um evento foi removido e a sequência tem um buraco. Mostre a `message` da API. Não é "erro ao carregar". |
| `401` | Sessão expirada → login. |

## Não faça

- Não trunque hash. Nunca.
- Não compare `confirmed_hash` com `replayed_hash` na tela: divergir é normal.
- Não trate `confirmed_hash_reproduced: null` como falha ou como pendência.
- Não esconda `false` atrás de linguagem suave. Um comprovante que ameniza a
  adulteração que detectou não serve para nada.
- Não use `supabase-js`.
