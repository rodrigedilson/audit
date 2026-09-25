# Observações de produção

O que morde na hora de aplicar. Cada item nasceu de um incidente real, e está
aqui porque a mensagem de erro sozinha apontava para o lugar errado.

Não é runbook de deploy nem lista de tarefas — para o que depende de decisão
sua, ver [`docs/todo_edilson.md`](../todo_edilson.md).

---

## 1. Aplicar SQL no editor do Supabase

### Cole pelo nome do arquivo, nunca pelo número

Os passos em `scripts/sql/migracoes/` são **gerados**, e o número é posição na
fila, não identidade. Toda migration nova renumera os passos seguintes: o que
era `28-bootstrap-escritorio.sql` virou `30-` e depois `33-`. Duas branches
criando migration ao mesmo tempo trocam os números uma da outra.

Combine sempre por nome — `28-auditoria-continua.sql` — e confira o cabeçalho
antes de colar. Ele diz `passo N de M`: se o `M` não bate com a quantidade de
arquivos no diretório, o arquivo aberto é de uma versão antiga.

### A ordem importa, e o passo 27 é o único com dependência dura

Cada passo pressupõe as tabelas do anterior. O `27-remove-projection-snapshots`
precisa vir antes do `28`, e os dois antes de qualquer coisa que leia auditoria.

### `create table if not exists` pula em silêncio

Este custou três rodadas de investigação contra a produção.

Se o nome da tabela já estiver ocupado — por resíduo de outra fase do produto,
por uma extensão, por um teste esquecido — o `create` é **ignorado sem aviso** e
o passo segue como se tivesse criado. O primeiro `create index` sobre a tabela
alheia então falha assim:

```
ERROR: 42703: column "tenant_id" does not exist
```

A mensagem culpa a coluna. O problema é a tabela. Quem lê conclui que a
migration está errada e vai procurar defeito onde não há.

Desde o PR #63 o passo 28 confere as quatro tabelas que cria e, achando
colisão, recusa seguir dizendo o nome:

> `A tabela public.audit_executions já existe e não é a deste passo: faltam as
> colunas tenant_id, cnpj, period, procedure_id, status.`

**Migration nova que crie tabela deve fazer o mesmo.** `if not exists` sozinho
serve para reaplicar o mesmo passo, e não distingue "já apliquei isto" de "esse
nome pertence a outra coisa" — situações que pedem respostas opostas.

### Quando um passo falhar, isole antes de investigar

```sql
select table_name,
       string_agg(column_name, ', ' order by ordinal_position) as colunas
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('<as tabelas que o passo cria>')
 group by table_name;
```

Qualquer linha que voltar já existe. Veja se tem dado antes de remover: tabela
vazia e sem leitor é resíduo; tabela com dado é a pergunta "de onde veio isso",
e não "posso apagar".

---

## 2. Depois de puxar a `main`

Rode `npm ci` **antes** de `npm run typecheck`. Dependência nova entra no
`package.json` e no lock, e quem não instalou vê um erro que não é do código —
foi o caso do `nodemailer`, que chegou no PR #65 e fazia a `main` parecer
quebrada.

---

## 3. Migration nova exige três passos, não um

1. O arquivo em `supabase/migrations/`, que é a fonte da verdade.
2. As **duas** entradas em `scripts/gerar-sql-completo.ts` — `TITULOS` e
   `DESCRICOES`.
3. `npm run sql:bundle`.

Sem as entradas do item 2 o bundle não quebra: o passo sai com o nome de
fallback, derivado do arquivo, e **sem descrição no cabeçalho**. Degrada em
silêncio, e o que você cola no Supabase perde a justificativa que explica o que
aquilo faz.

> **Pendente agora:** `20260927100000_view_exposta_ao_anon.sql` está sem as duas
> entradas, e por isso o passo gerado saiu como `32-view_exposta_ao_anon.sql` —
> com underline, fora do padrão hifenizado, e sem descrição.

O `environment-doctor` também cita nomes de passo ao acusar tabela ausente.
Renumeração sem atualizar o mapa faz o diagnóstico mandar você abrir o arquivo
errado; há teste que pega isso.

### Conflito no bundle é esperado

Duas branches que criem migration conflitam em **todos** os arquivos gerados,
porque o cabeçalho traz `passo N de M`. Resolve-se regenerando com
`npm run sql:bundle`, nunca editando o gerado à mão. A fonte da verdade
(`supabase/migrations/`) costuma mesclar limpa.

---

## 4. O que nasce vazio ou não conferido, de propósito

O produto prefere dizer "não sei" a chutar. Estas tabelas nascem sem conteúdo
útil, e ligá-las é ato humano:

| Tabela | Estado ao nascer | Efeito enquanto assim |
|---|---|---|
| `evaluation_criteria` | 4 linhas, todas `verified = false` | Execução de auditoria sai `inconclusive`; achados aparecem **sem afirmar** |
| `tax_rules` | vazia | A apuração devolve o devido como nulo com o motivo, nunca um número assumido |
| `deadline_rules` | vazia | Nenhum alerta de prazo é emitido |
| `fiscal_codes`, `ncm_flags` | vazias | Trilhas de código saem `not_applicable`, e não `passed` |

Isso não é pendência de deploy: é o contrato. Alertar na data errada é pior do
que não alertar, e dizer "conferido" onde nada foi comparado é a única coisa que
o produto não pode fazer.

Para ligar um critério é preciso apontar o texto conferido:

```sql
update evaluation_criteria
   set verified = true,
       source_ref = '<URL do texto oficial>',
       verified_at = now()
 where criterion_id = 'lc-214-credito-documento-habil';
```

A constraint `criterios_conferidos_tem_fonte` recusa marcar como conferido sem
`source_ref`. É deliberado: sem ela, "conferido" viraria um clique.

---

## 5. A chave anon é pública, e view não tem RLS

A chave `anon` vai no pacote do frontend e qualquer pessoa a extrai. O que
protege cada tabela é a RLS.

**View não tem RLS**, e por padrão no Postgres roda com o privilégio de quem a
definiu (`security_invoker = off`), atravessando a RLS das tabelas de baixo. Em
25/09/2026 uma view residual servia 192 notas fiscais reais ao `anon`, com CNPJ
do emitente, número, série e data — e a checagem de visibilidade do `doctor`
passava, porque conferia uma lista de tabelas conhecidas e a view não estava na
lista.

A lição vale além do incidente: **conferir configuração de uma lista conhecida
não é o mesmo que conferir o que de fato responde**. Objeto novo exposto ao
`anon` — view, função, tabela — precisa entrar na conferência de fora para
dentro.

Ao fechar um furo desses, prefira `revoke` a `drop`: a definição costuma ser a
única cópia que existe, e apagá-la troca um problema por outro.

---

## 6. Depois de aplicar, confira

```sql
-- os quatro critérios existem e nenhum foi conferido ainda
select count(*) filter (where not verified) as nao_conferidos,
       count(*)                             as total
  from public.evaluation_criteria;

-- RLS ligada onde há tenant_id
select relname,
       case when relrowsecurity then 'on' else 'OFF' end as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and relname in ('audit_executions', 'audit_findings', 'audit_reversals')
 order by relname;
```

Esperado: `4 / 4` no primeiro, e `on` nos três do segundo. `evaluation_criteria`
fica com RLS **desligada** por decisão — uma norma não pertence a um escritório,
e a tabela não tem `tenant_id`.

Para o resto, `npm run doctor` contra o banco de produção cobre schema, RLS,
funções e tabelas ausentes, e não morre na primeira surpresa.
