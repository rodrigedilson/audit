# ADR-007 — Uso não assistido do certificado A1

**Status:** Aceita
**Data:** 2026-09-24 (proposta) · 2026-09-26 (aceita)

> Esta ADR foi escrita como "ADR-006 — proposta" e colidia em número com a
> [ADR-006](ADR-006-coleta-dfe-sefaz.md), da coleta de DF-e. Renumerada ao ser
> aceita.

## Contexto

O cofre guardava o PFX cifrado e **não guardava a senha**. Isso impedia usar o
certificado sem alguém digitando a senha, e a coleta automática de DF-e, que é
uma das razões de o cofre existir, dependia exatamente disso.

Uso não assistido significa que o sistema consegue usar a chave sozinho. Não há
arranjo criptográfico que evite isso. A proteção passa a ser:

1. a chave mestra fora do banco (Doppler), nunca ao lado do dado cifrado;
2. a trilha: `certificate.used` com finalidade, alvo, resultado e autoria, no
   log append-only;
3. a autorização: só o owner guarda, remove e liga o uso não assistido.

## Decisão

**Reembrulhar sem senha no upload (opção B da proposta), e uso não assistido só
por opt-in explícito do owner, por CNPJ.**

- **Guarda** (em produção desde a coleta de DF-e, ADR-006): no upload, a chave e
  a cadeia saem do PKCS#12 e são guardadas em PEM, cifradas pelo cofre
  (`credential_format = 'pem_bundle'`). Não existe senha guardada: o segredo é
  um só, a chave mestra. O `fingerprint` continua sendo o SHA-256 do PFX
  original, para manter o valor de "é este o arquivo que você nos deu".
- **Opt-in:** `PUT /clients/{cnpj}/dfe/auto {enabled}`, só owner, exige
  certificado `pem_bundle` e a feature `coleta_dfe` do plano. A mudança vai para
  o log como `client.updated` (`dfe_auto_sync`), em nome de quem mudou, e fica
  em `clients.dfe_auto_sync_by` e `dfe_auto_sync_at`.
- **Agendador:** `startDfeScheduler`, a cada 10 minutos, no processo da API e só
  com `startWorkers` (o `serve`, em prod). Enfileira a coleta de todo CNPJ com a
  opção ligada, certificado utilizável, plano com `coleta_dfe`, SEFAZ liberada
  (`blocked_until` vencido) e nenhum job pendente. Como a SEFAZ bloqueia por uma
  hora depois de alcançada a fila, o efeito é uma coleta por hora por CNPJ.
- **Autoria:** o job do agendador tem `trigger = 'schedule'` e `requested_by`
  nulo. O uso do A1 sai em nome do orquestrador (`closer`), e cada
  `certificate.used` leva `triggered_by: 'schedule'` e `enabled_by` (quem ligou
  a opção). O pedido manual leva `triggered_by: 'manual'` e sai em nome de quem
  pediu, como antes.
- **Desligar vale na hora:** o job agendado confere a opção ao executar. Se ela
  foi desligada depois do enfileiramento, o job falha sem usar o certificado.
- **Dev não liga:** sem gateway da SEFAZ (dev), a rota responde 503. O banco de
  dev é o de produção, e ligar a opção de lá faria o agendador de produção
  coletar por uma decisão tomada num ambiente de teste.

## Consequências

- A coleta automática que a tabela de preço anuncia passa a existir, e o rótulo
  de `coleta_dfe` diz que ela depende de o owner ligá-la.
- A trilha distingue coleta pedida de coleta agendada, e uso de DF-e de
  qualquer finalidade futura (NFS-e, CT-e), pelo `purpose`.
- **Pendente, fora do código:** o termo de uso precisa dizer, em palavras que um
  contador entende, que guardar o A1 e ligar a coleta agendada autoriza o
  sistema a agir em nome da empresa nas finalidades listadas.
- O certificado da API do Conformidade Fácil continua fora do cofre: ele é da
  operação, não de um cliente, e carrega tabela global de referência.
