# Brief 02 — Calculadora de preço com faixas de volume

> Cole este arquivo inteiro no Lovable. Ele é autocontido.

## O que estamos construindo

Uma página pública de preço onde o escritório informa quantos CNPJs tem de cada
regime tributário e vê, na hora, quanto vai pagar — com a conta aberta.

## Por que ela existe

Nenhum concorrente publica preço. Todos escondem atrás de "fale com um
consultor". Publicar é o nosso contraposicionamento, e ele só funciona se a
conta for **explicável**: um total sozinho, sem a decomposição, seria opaco do
mesmo jeito.

Por isso a API devolve as parcelas separadas em vez de já somadas. A tela existe
para mostrar essas parcelas.

## Contrato

### Catálogo

```
GET {VITE_AUDIT_API_URL}/plans      (sem Authorization)
```

```json
{
  "minimum_cents": 15000,
  "minimum_formatted": "R$ 150,00",
  "cap_cents": 2500000,
  "tiers": [
    { "from_clients": 1,    "discount_bps": 0,    "label": "Até 100 CNPJs" },
    { "from_clients": 101,  "discount_bps": 1500, "label": "101 a 300 CNPJs" },
    { "from_clients": 301,  "discount_bps": 3000, "label": "301 a 600 CNPJs" },
    { "from_clients": 601,  "discount_bps": 4000, "label": "601 a 1.000 CNPJs" },
    { "from_clients": 1001, "discount_bps": 5000, "label": "Acima de 1.000 CNPJs" }
  ],
  "plans": [
    { "regime": "mei", "monthly_cents": 900, "monthly_formatted": "R$ 9,00",
      "features": ["saude_cadastro", "coleta_dfe", "simulador_opcao"] }
  ]
}
```

`discount_bps` está em pontos-base: `1500` = 15%.

### Cotação

```
POST {VITE_AUDIT_API_URL}/price-calculator      (sem Authorization)
{ "clients": [ { "regime": "simples_hibrido", "quantity": 1200 } ] }
```

Regimes: `mei`, `simples_integrado`, `simples_hibrido`, `lucro_presumido`,
`lucro_real`. Até 5 entradas, `quantity` de 0 a 10.000, soma máxima 20.000.

```json
{
  "snapshot_version": 2,
  "billable_clients": 1200,
  "lines": [
    {
      "regime": "simples_hibrido",
      "quantity": 1200,
      "unit_cents": 2900,
      "subtotal_cents": 3480000,
      "volume_discount_cents": 1102000,
      "tiers": [
        { "from_clients": 1,    "to_clients": 100,  "label": "Até 100 CNPJs",
          "quantity": 100, "discount_bps": 0,
          "gross_cents": 290000, "discount_cents": 0, "net_cents": 290000 },
        { "from_clients": 1001, "to_clients": null, "label": "Acima de 1.000 CNPJs",
          "quantity": 200, "discount_bps": 5000,
          "gross_cents": 580000, "discount_cents": 290000, "net_cents": 290000 }
      ]
    }
  ],
  "subtotal_cents": 3480000,
  "volume_discount_cents": 1102000,
  "cap_adjustment_cents": 0,
  "minimum_adjustment_cents": 0,
  "effective_discount_bps": 3167,
  "total_cents": 2378000,
  "total_formatted": "R$ 23.780,00",
  "minimum_cents": 15000
}
```

## A regra mais importante desta tela

**`subtotal_cents` é bruto. Não é o que se paga.** As quatro parcelas fecham
por soma:

```
subtotal_cents − volume_discount_cents + cap_adjustment_cents + minimum_adjustment_cents = total_cents
```

Mostrar `subtotal_cents` como total exibiria uma conta **maior** que a real —
R$ 34.800 em vez de R$ 23.780 no exemplo acima. Use sempre `total_cents`, e
mostre as parcelas que levaram até ele.

Sinais de cada parcela: `volume_discount_cents` é sempre ≥ 0 (subtrai),
`cap_adjustment_cents` é sempre ≤ 0 (já vem negativo, some),
`minimum_adjustment_cents` é sempre ≥ 0 (soma).

## Como montar a tela

### Entrada

Uma linha por regime, com rótulo em português e um campo numérico:

| `regime` | Rótulo |
|---|---|
| `mei` | MEI |
| `simples_integrado` | Simples Nacional — integrado |
| `simples_hibrido` | Simples Nacional — híbrido |
| `lucro_presumido` | Lucro Presumido |
| `lucro_real` | Lucro Real |

Ao lado de cada um, o preço unitário vindo de `/plans` (`monthly_formatted`).
Recalcule a cotação conforme a pessoa digita, com debounce de ~400 ms. Envie só
os regimes com `quantity > 0`.

### Resultado — a conta aberta

Um painel `rounded-panel` com as linhas nesta ordem, valores à direita e em
`font-mono`:

```
Subtotal                                    R$ 34.800,00
Desconto por volume (31,67%)               − R$ 11.020,00
Ajuste de teto                                    R$ 0,00      ← só se ≠ 0
Assinatura mínima                                 R$ 0,00      ← só se ≠ 0
─────────────────────────────────────────────────────────
Total mensal                                R$ 23.780,00
```

Omita as linhas de teto e mínimo quando forem zero — mostrar "R$ 0,00" três
vezes deixa a conta confusa. O desconto percentual vem de
`effective_discount_bps / 100`.

### A escada de faixas

É o que explica o desconto, e vale a pena mostrar. Para cada linha de `lines`
com `tiers`, uma tabela pequena:

| Faixa | CNPJs | Desconto | Valor |
|---|---|---|---|
| Até 100 | 100 | — | R$ 2.900,00 |
| 101 a 300 | 200 | 15% | R$ 4.930,00 |
| 301 a 600 | 300 | 30% | R$ 6.090,00 |
| 601 a 1.000 | 400 | 40% | R$ 6.960,00 |
| Acima de 1.000 | 200 | 50% | R$ 2.900,00 |

Use `label` como rótulo; quando vier `null`, monte de `from_clients`/`to_clients`
(com `to_clients: null` = faixa aberta, "acima de N").

Acrescente uma frase explicando que o desconto é **marginal**: *"Cada faixa
desconta apenas os CNPJs que caem dentro dela, como acontece com as alíquotas do
imposto de renda."* Sem isso, alguém vai perguntar por que 1.200 CNPJs não
pagaram 50% de desconto sobre tudo.

Acima de `/plans` → `tiers`, mostre também a escada completa como tabela de
preço pública, mesmo antes de a pessoa digitar qualquer número.

### Contexto

- `minimum_cents` de `/plans`: "Assinatura mínima de R$ 150,00/mês."
- `cap_cents`, quando não for `null`: "Teto de R$ 25.000,00/mês."
- Features por plano: liste de `plans[].features` — são chaves
  (`saude_cadastro`, `apuracao_dual`, `credito_em_risco`, `white_label`,
  `sped_completo`…). Mapeie para português na tela.

## Estados

| Estado | O que mostrar |
|---|---|
| Vazio (tudo zero) | Escada de preço pública + convite a preencher. Sem total. |
| Carregando | Mantenha o último total visível, esmaecido. Não pisque o layout. |
| `400` | Erro de campo inline — quantidade fora de 0 a 10.000. |
| `422` | `{ message }` — a soma passou de 20.000 CNPJs. |
| `503` com `code: "billing_not_configured"` | "Preços indisponíveis no momento." |

## Não faça

- Não trate `subtotal_cents` como total. É a armadilha número um desta tela.
- Não recalcule desconto no cliente: os valores já vêm prontos e arredondados
  por faixa; refazer a conta produz centavos que não fecham.
- Não esconda a escada atrás de "fale com um consultor". Ela é pública de
  propósito.
- Não use `supabase-js`.
