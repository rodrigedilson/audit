# Brief 04 — Correções nas duas telas públicas

> Cole este arquivo inteiro no Lovable. Ele é autocontido.
>
> **As duas telas já existem.** Este brief corrige pontos específicos delas —
> não é para recriar nada. Os arquivos são `src/pages/DiagnosticoReforma.tsx` e
> `src/pages/CalculadoraPreco.tsx`.

---

## Correção 1 — o e-mail não deve reenviar os XMLs

**Arquivo:** `src/pages/DiagnosticoReforma.tsx`

### O que acontece hoje

`sendLead` chama `send(true)`, que monta um `FormData` com **todos os arquivos
de novo** e faz outro `POST /reform-readiness`. Quando o visitante pede a cópia
por e-mail, os mesmos 50 XMLs são enviados e processados uma segunda vez, e um
segundo diagnóstico é contado no funil para a mesma pessoa.

Isso não era erro de quem construiu: a API não tinha rota para registrar só o
e-mail, e o brief anterior não dizia o que fazer. **Agora tem.**

### O que muda

`POST /reform-readiness` passou a devolver `report_id`. Guarde-o no estado junto
do relatório:

```json
{
  "report_id": "3f2a91c4-8b7e-4d1a-9c55-2e6b0f8a71d3",
  "generated_at": "...",
  "documents_ready": { "...": "..." }
}
```

O envio do e-mail passa a ser uma chamada própria, **sem arquivo nenhum**:

```
POST {VITE_AUDIT_API_URL}/reform-readiness/lead     (sem Authorization)
Content-Type: application/json

{
  "report_id": "<o report_id que veio no relatório>",
  "email": "voce@escritorio.com.br",
  "consent": true,
  "source": "landing"
}
```

Resposta `200`: `{ "lead_registered": true }`.

### Estados de erro desta chamada

| Resposta | Significado | O que mostrar |
|---|---|---|
| `422` | E-mail malformado ou `consent` diferente de `true` | mensagem da API, inline |
| `404` | `report_id` não existe **ou** já tem e-mail registrado | "Este relatório já foi enviado." e desabilite o botão |
| `429` com `code: "rate_limited"` | Muitos envios seguidos | "Aguarde N segundos", de `retry_after_seconds` |

O `404` não distingue os dois casos de propósito — distinguir confirmaria a
existência de um id a quem está chutando. Trate como "já enviado".

### O que não muda

O `POST /reform-readiness` continua aceitando `source`, e **não** deve mais
receber `email` nem `consent`. O relatório continua saindo sem pedir e-mail:
essa parte está correta hoje e deve permanecer.

---

## Correção 2 — os nomes das features vêm da API

**Arquivo:** `src/pages/CalculadoraPreco.tsx`

### O que acontece hoje

Existe um mapa `FEATURES` escrito à mão no topo do arquivo, com um `featureLabel`
que cai num fallback (`k.replace(/_/g, " ")`) quando a chave não está no mapa.

Duas consequências concretas:

- Duas chaves do mapa **não existem na API**: `trilhas` e `assistente`. São
  código morto que nunca casa.
- Três chaves reais **não estão no mapa**: `calendario`, `assistente_fiscal` e
  `dossie_saldo_credor`. Elas caem no fallback e aparecem como
  "Calendario", "Assistente fiscal" e "Dossie saldo credor" — sem acento, e sem
  o nome comercial certo.

### O que muda

O mesmo `GET /plans` agora devolve `feature_labels`:

```json
{
  "minimum_cents": 15000,
  "cap_cents": 2500000,
  "tiers": [ "..." ],
  "plans": [ "..." ],
  "feature_labels": {
    "saude_cadastro": {
      "label": "Saúde do cadastro de itens",
      "description": "Aponta item sem NCM, código incompatível e classificação que contamina a apuração.",
      "sort_order": 10
    },
    "apuracao_dual": {
      "label": "Apuração dual, nota a nota",
      "description": "Tributos atuais e IBS/CBS lado a lado no mesmo item, com memória de cálculo.",
      "sort_order": 40
    }
  }
}
```

Remova o mapa `FEATURES` e o fallback. Passe a usar:

- `feature_labels[chave].label` no item da lista;
- `feature_labels[chave].description` como subtítulo ou tooltip — é o que
  explica o que o escritório ganha; o rótulo sozinho não vende nada;
- `feature_labels[chave].sort_order` para ordenar. A ordem em `plans[].features`
  é a das ondas que entregaram cada funcionalidade, não a que o cliente quer ler.

**Chave sem rótulo no mapa não deve aparecer na tela.** Nada de inventar nome a
partir da chave: se algo não tem rótulo, é sinal de que a tabela do servidor
ficou para trás, e um nome improvisado esconde esse defeito em vez de expô-lo.

As onze chaves reais, para conferência (mas leia sempre da API, não daqui):

```
saude_cadastro · coleta_dfe · simulador_opcao · apuracao_dual · contra_apuracao
calendario · assistente_fiscal · credito_em_risco · dossie_saldo_credor
sped_completo · white_label
```

---

## O que continua valendo

Do [README](README.md), duas armadilhas que estas telas precisam respeitar e que
não mudaram:

**`subtotal_cents` é bruto, não é o que se paga.** As quatro parcelas fecham por
soma: `subtotal − volume_discount + cap_adjustment + minimum_adjustment = total`.

**Existem dois `429` com significados opostos.** `rate_limited` é limite do
diagnóstico anônimo; o outro é limite de plano contratado. Bifurque por `code`,
nunca por status.
