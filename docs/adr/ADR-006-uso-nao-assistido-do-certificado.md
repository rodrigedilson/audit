# ADR-006 — Uso não assistido do certificado A1

**Status:** proposto, aguardando decisão
**Data:** 2026-09-24

## Contexto

O cofre guarda o PFX cifrado com AES-256-GCM e **não guarda a senha do PFX**. A
decisão está escrita no código e tem teste que a garante: *"a senha do
certificado não é persistida em lugar algum"*. O raciocínio original está no
próprio `certificate-vault.ts` — guardar a senha ao lado do arquivo cifrado
anularia a cifragem.

O problema é que esse desenho **impede o uso do certificado sem alguém
digitando a senha**, e três coisas do roadmap dependem exatamente disso:

- **Coleta automática de DF-e** (Onda 4), que é uma das razões de o cofre
  existir.
- **API do Conformidade Fácil** via mTLS, que atualiza as tabelas oficiais de
  código sem depender de raspagem de página.
- **Consulta de NFS-e nacional e CT-e**, pela mesma via.

Hoje o cliente da API lê o certificado de um arquivo que o operador aponta
(`CFF_CERT_PFX`). Funciona para rodar um script à mão, e não para um serviço
que coleta documentos todo dia.

## O conflito, dito sem rodeio

Uso não assistido significa que **o sistema precisa conseguir usar a chave
sozinho**. Não há arranjo criptográfico que evite isso: se o serviço assina sem
humano presente, o serviço tem o suficiente para assinar. A pergunta não é se o
sistema terá esse poder, é como ele fica registrado e limitado.

A proteção real, nesse cenário, deixa de ser a senha e passa a ser:

1. a chave mestra fora do banco, num secret manager com log de acesso;
2. a trilha de uso — `certificate.used` com finalidade, serviço, resultado e IP,
   em log append-only;
3. a autorização por papel, que restringe quem pode guardar e remover.

Os três já existem.

## Opções

### A. Guardar a senha, cifrada com a chave mestra

Uma coluna a mais, cifrada pelo mesmo cofre.

- **A favor:** menor mudança; o PFX guardado continua sendo exatamente o arquivo
  que o cliente enviou, o que ajuda em disputa ("é este o arquivo que você nos
  deu").
- **Contra:** contraria o comentário e o teste atuais, e alguém que leia o
  código sem contexto vai achar que é regressão. Exige reescrever os dois.

### B. Reembrulhar sem senha no momento do upload

Extrair chave e certificado do PKCS#12 e guardar reembrulhado sem senha, dentro
da mesma cifragem AES-GCM.

- **A favor:** não existe "senha guardada" em lugar nenhum; o segredo é um só, a
  chave mestra.
- **Contra:** o que está guardado deixa de ser byte a byte o arquivo do cliente,
  e o `fingerprint` atual — SHA-256 do PFX original — precisaria continuar sendo
  do original para manter o valor probatório.

### C. Não fazer, e aceitar que o uso é sempre assistido

- **A favor:** mantém a decisão atual intacta.
- **Contra:** cancela a coleta automática, que é diferencial anunciado, e mantém
  a atualização das tabelas oficiais dependendo de raspagem de página.

## Recomendação

**Opção B**, com três condições:

1. O `fingerprint` continua sendo o do PFX original, para não perder o valor
   probatório de "é este o arquivo que você nos deu".
2. Todo uso não assistido emite `certificate.used` com `purpose` próprio — a
   consulta ao Conformidade Fácil não pode ficar indistinguível de uma coleta de
   DF-e na trilha.
3. O termo de uso do produto diz, em palavras que um contador entende, que
   guardar o A1 aqui autoriza o sistema a agir em nome da empresa nas
   finalidades listadas. Custódia sem consentimento explícito é o tipo de coisa
   que aparece numa auditoria como achado, e com razão.

A opção A é aceitável e mais barata; a B é preferida porque deixa **um** segredo
em vez de dois.

## Consequências

Enquanto esta ADR não for decidida:

- o cliente do Conformidade Fácil lê o certificado de arquivo apontado pelo
  operador, e a atualização das tabelas é manual;
- a coleta automática de DF-e não pode ser construída;
- o cofre continua sendo custódia com uso assistido, que é menos do que o
  produto anuncia.

Nada disso é urgente enquanto o acervo de produção estiver vazio. Passa a ser no
dia em que o primeiro cliente guardar um A1 esperando coleta automática.
