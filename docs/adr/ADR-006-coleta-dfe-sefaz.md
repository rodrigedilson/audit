# ADR-006 — Coleta de DF-e na SEFAZ: distribuição por NSU e ciência da operação

- **Status:** Aceita
- **Data:** 2026-09-24

## Contexto

`POST /clients/{cnpj}/sync` respondia 501. A única entrada de NF-e era o upload
manual de XML. O escritório baixava nota por nota no portal da SEFAZ ou pedia ao
cliente, e é essa rotina que o produto se propõe a eliminar.

O Ambiente Nacional oferece dois serviços para isso, os dois com mTLS pelo
certificado A1 do contribuinte:

- **NFeDistribuicaoDFe** (`nfeDistDFeInteresse`, `distDFeInt` versão 1.01):
  devolve, por NSU, os documentos em que o CNPJ é parte. Para nota de
  **entrada**, devolve só o **resumo** (`resNFe`) até o destinatário se
  manifestar.
- **NFeRecepcaoEvento4**: recebe o evento de **ciência da operação** (210210,
  `cOrgao` 91), assinado em XMLDSig. Depois dele, a NF-e completa (`procNFe`)
  chega na distribuição seguinte.

Havia três impedimentos no código:

1. **O cofre guardava o PFX com a senha, e descartava a senha.** O arquivo
   decifrado não abria, e sem a chave privada não há mTLS nem assinatura.
2. A tabela `jobs` não tinha produtor nem consumidor.
3. O banco é compartilhado entre dev e prod (ver SEGREDOS.md). Uma coleta em
   homologação a partir de dev gravaria notas de teste na base real.

## Decisão

### 1. O cofre guarda a credencial, não o PFX

No upload, a senha abre o PFX **uma vez**. A chave privada e a cadeia de
certificados são reexportadas em PEM, e esse pacote é o que o cofre cifra
(AES-256-GCM, chave mestra fora do banco, como antes). A senha continua sem ser
guardada em lugar nenhum.

A proteção não muda. A senha do PFX só protegia o arquivo enquanto ninguém a
tivesse, e o sistema precisa usá-lo sem ninguém digitar nada. A proteção real
sempre foi a chave mestra.

Cada linha de `certificates` passa a dizer o formato (`credential_format`):

- `pem_bundle` para uploads novos;
- `pfx_protected` para os antigos, que não servem para coleta. A sincronização
  responde pedindo o reenvio.

Produção tinha zero certificados guardados quando esta ADR foi escrita, então
não há acervo para migrar.

O `fingerprint` passa a ser o do material guardado, porque é ele que a
recifragem confere.

### 2. Worker no próprio processo da API, com `for update skip locked`

`POST /sync` enfileira um `jobs` (`dfe_sync`) e responde **202** com o `job_id`.
Se já houver job pendente do CNPJ, devolve o mesmo, em vez de enfileirar outro.
Um worker no processo da API toma um job por vez com
`select … for update skip locked`, e isso é seguro mesmo com mais de uma
instância.

Um serviço separado foi descartado por agora. O Render roda uma instância, e um
segundo serviço duplicaria deploy, segredos e monitoramento para um volume que
cabe no processo da API. A fila é a tabela, então separar depois é mudar quem
consome, e não o contrato.

### 3. Estado por CNPJ e as regras de consumo da SEFAZ

`dfe_sync_state (tenant_id, cnpj)` guarda `ult_nsu`, `max_nsu`, o último
resultado e `blocked_until`. A SEFAZ pune consumo indevido:

- **`cStat 656`** (consumo indevido): nada de nova consulta por uma hora.
  `blocked_until = now() + 1h`, e o job termina dizendo isso.
- **`cStat 137`** (nenhum documento), ou `ult_nsu` alcançando `max_nsu`: o
  próximo pedido só sai uma hora depois. Pedir antes não traz nada e conta
  como consumo indevido.
- Um job consulta em laço até alcançar `max_nsu`, com teto de lotes por
  execução.

### 4. O que cada documento vira

- **`procNFe`** entra pelo mesmo caminho do upload manual
  (`IngestionService.ingestXmlBatch`): mesmas 7 camadas, mesmo `doc.received`.
- **`resNFe`** de nota em que o CNPJ é destinatário: ciência da operação, uma
  por chave, com teto por execução. A resposta `573` (duplicidade) conta como
  sucesso: a ciência já existia.
- **Eventos** (`resEvento`, `procEventoNFe`) ficam todos em `dfe_events`,
  aplicados ou não. O cancelamento (110111, e 110112 por substituição) com
  `cStat` 135 ou 155 de nota que está na base vira `doc.cancelled`: a nota fica
  em `documents`, marcada em `cancelled_at`, e sai das somas (apuração, crédito,
  dossiê, simulador, propagação). Cancelamento de nota que ainda não chegou
  espera a coleta seguinte. Em competência **confirmada** nada muda (INV-001): o
  evento fica com `blocked_reason` e aparece em `GET /clients/{cnpj}/dfe` como
  `cancellations_needing_rectification`, e a correção é a retificação. Os demais
  eventos só ficam guardados.

Cada chamada à SEFAZ emite `certificate.used` (`dfe_distribution` ou
`manifestation`, com o resultado), em nome de **quem pediu** a sincronização.
`jobs.requested_by` guarda quem foi. O log de uso do A1 é onde mais importa
saber quem agiu.
A coleta agendada, por opt-in do owner, não tem quem pediu: sai em nome do
orquestrador, com quem ligou a opção no payload ([ADR-007](ADR-007-uso-nao-assistido-do-certificado.md)).

### 5. Assinatura XMLDSig sem biblioteca

A ciência é assinada como a NF-e exige: RSA-SHA1, C14N 1.0, `enveloped
signature` e o certificado em `X509Data`. O XML é gerado pelo próprio sistema,
sem espaços, e com isso a forma canônica é construída diretamente, sem um
canonicalizador genérico. Os testes conferem a assinatura com uma verificação
independente.

### 6. Ambiente

A coleta só existe com `AUDIT_ENV=prod`, contra a SEFAZ de **produção**
(`tpAmb=1`).

Em dev, `POST /sync` responde 503. Com o banco compartilhado, homologação em dev
gravaria notas de teste na base real, pelo mesmo motivo que dev não fala com o
Asaas. O fluxo é testado com um gateway dublado.

## Consequências

- Certificado enviado antes desta ADR precisa ser reenviado para coletar. A tela
  mostra isso pelo `credential_format`.
- A NF-e de entrada leva **duas coletas** para chegar completa: a primeira faz a
  ciência, e a seguinte traz o XML.
- A cadeia TLS dos dois servidores foi conferida em 2026-09-24: a distribuição
  (`www1.nfe.fazenda.gov.br`) usa GlobalSign Root R46, e a recepção de evento
  (`www.nfe.fazenda.gov.br`) usa Let's Encrypt (ISRG). As duas estão entre as CAs
  padrão do Node, então não há cadeia embutida nem verificação TLS desligada. Se
  a SEFAZ trocar para uma CA ICP-Brasil, a coleta falha com erro de TLS, e a
  correção é incluir a cadeia, nunca `rejectUnauthorized: false`.
- Confirmação, desconhecimento e "operação não realizada" (210200, 210220 e
  210240) ficam de fora: são decisões do contador sobre a operação, e não
  automação.
