# Briefs para o Lovable — telas da API `audit`

> **Esta pasta é a fonte da verdade.** A cópia em
> `sped-genius-hub/docs/briefs-lovable/` é a consumida, e segue esta — nunca o
> contrário, pela mesma regra que já vale para o design system (ver
> [FRONTEND.md](../FRONTEND.md)). Ao mudar um contrato aqui, atualize os dois.
>
> Os contratos JSON abaixo foram conferidos campo a campo contra a API rodando:
> nenhum campo inventado, nenhum campo real fora da documentação.

Três telas novas, cada uma num arquivo desta pasta. **Cada brief é
autocontido**: dá para colar um deles no Lovable sem ler os outros. Isso é
proposital — prompt gigante produz tela genérica.

| Brief | Tela | Login | Estado |
|---|---|---|---|
| [01](01-diagnostico-publico.md) | Diagnóstico de prontidão para a reforma | **não** | no ar, ver brief 04 |
| [02](02-calculadora-de-precos.md) | Calculadora de preço com faixas de volume | **não** | no ar, ver brief 04 |
| [03](03-comprovante-de-integridade.md) | Comprovante de integridade da competência | sim | **implementada** |
| [04](04-correcoes-nas-telas-publicas.md) | Correções nas telas 01 e 02 | — | **a aplicar** |

**Comece pelo [04](04-correcoes-nas-telas-publicas.md)** se as telas 01 e 02 já
existem: ele corrige pontos específicos delas, sem recriar nada. Os briefs 01 e
02 já incorporam as mesmas mudanças e servem para construir do zero.

---

## Antes de colar qualquer um

### De onde vêm os dados

Estas telas **não falam com o Supabase deste repositório**. Elas consomem a API
`audit`, que é um serviço Fastify separado, com banco próprio:

```
VITE_AUDIT_API_URL=http://localhost:3000/v1   # dev
```

O cliente `supabase` de `src/integrations/supabase/client.ts` continua servindo
o que já existe aqui (SPED, entidades, cross-reference, grafo, CFOP). Ele **não**
toca nas rotas abaixo, e nenhuma dessas telas deve importá-lo.

A razão não é organizacional: a apuração fiscal passa por um pipeline de sete
camadas de validação e um event log append-only do lado do Fastify. Ler a tabela
por baixo devolveria número sem a trilha que o torna defensável, que é o produto
inteiro.

### Identidade visual

O EJR Design System 2.0 já está aplicado neste repositório. **Não redefina
nada** — use os tokens que existem:

| O quê | Token | Valor |
|---|---|---|
| Verde institucional | `bg-primary`, `text-primary` | `#365D5A` — só CTA, link, foco e identidade |
| Títulos | `font-heading` | Montserrat |
| Corpo | `font-body` / `font-sans` | Inter |
| Números fiscais, CNPJ, hash, chave | `font-mono` | JetBrains Mono — **obrigatório** |
| Raio | `rounded-card` (12px), `rounded-panel` (16px) | |
| Altura de controle | `h-control` (36px) | |
| Largura máxima | `max-w-container` (1200px) | |

Regras que não se negociam: **light-only** (dark mode é proibido, `.dark`
espelha o claro), sem glow, sem gradiente pesado, sem sombra forte.

### As quatro armadilhas

Estas são as que já custaram retrabalho. Valem para as três telas.

**1. Existem dois `429` com significados opostos.** Bifurque por `code`, nunca
por status:

| `code` | O que é | O que a tela faz |
|---|---|---|
| `rate_limited` | Limite do diagnóstico público (3/min, 20/dia por IP) | "Aguarde N segundos", com `retry_after_seconds` |
| qualquer outro | Limite do plano contratado | Tela de upgrade |

Mandar um visitante anônimo para a tela de upgrade porque ele clicou duas vezes
é absurdo, e é o erro que acontece se a tela olhar só o status.

**2. `subtotal_cents` é bruto — não é o que se paga.** A fatura tem quatro
parcelas que fecham por soma:

```
subtotal_cents − volume_discount_cents + cap_adjustment_cents + minimum_adjustment_cents = total_cents
```

Mostrar `subtotal_cents` como total exibiria ao escritório uma conta **maior**
que a real. Sempre use `total_cents`, e mostre as parcelas.

**3. Não recalcule percentual na tela.** O relatório de prontidão já devolve
`ready_pct` pronto, com uma casa. Refazer a divisão produz um número que diverge
do que o próprio relatório afirma logo acima.

**4. Nada de muro de e-mail.** O diagnóstico entrega o resultado sempre. O
e-mail é opcional e vem **depois** do relatório. Esconder resultado atrás de
formulário é exatamente a opacidade contra a qual o produto se posiciona — o
preço é público pelo mesmo motivo.

### Contrato de erro, uma vez para todas

| HTTP | Forma | Como mostrar |
|---|---|---|
| 400 | `{ code, message, details }` | erro de campo, inline |
| 401 | `{ code, message }` | sessão expirada → login |
| 404 | `{ code, message }` | "não encontrado nesta carteira" |
| 409 | `{ code, message }` | conflito de estado; mostre a mensagem da API |
| 422 | `{ rejected, layer, reason, message }` | **inconsistência fiscal**: mostre camada + motivo em PT-BR |
| 429 | `{ code, message, retry_after_seconds? }` | ver armadilha 1 |
| 503 | `{ code, message }` | indisponível; nunca "erro interno" |

O `422` nunca é "erro ao salvar". Ele carrega qual das sete camadas barrou e por
quê — é a informação mais valiosa que a API produz, e jogá-la fora num toast
genérico desperdiça o melhor do produto.

A fonte da verdade do contrato é `docs/api/openapi.yaml` no repositório `audit`.
