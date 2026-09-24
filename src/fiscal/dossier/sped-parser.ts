/**
 * Leitor de EFD-Contribuições (SPED PIS/Cofins).
 *
 * Só os registros de que o dossiê de saldo credor precisa, e isso é declarado
 * de propósito: um parser que anuncia ler o layout inteiro e ignora metade dos
 * registros em silêncio é pior do que um que diz o que lê.
 *
 * | Registro | O que traz |
 * |----------|------------|
 * | `0000`   | versão do layout, CNPJ e período da escrituração |
 * | `C100`   | documento fiscal, com a chave de acesso |
 * | `C170`   | item do documento, com CST, base, alíquota e valor de PIS/Cofins |
 * | `M100` / `M500` | crédito apurado no período, por código de crédito |
 * | `1100` / `1500` | controle de crédito de períodos anteriores — o saldo credor |
 *
 * **Os campos são lidos por posição**, como o layout define. Posição errada
 * produziria valor de dinheiro errado, então cada campo é validado: data tem de
 * parsear, valor tem de ser numérico e chave de acesso tem de ter 44 dígitos.
 * Registro que não valida é recusado com o motivo, e não aceito pela metade.
 *
 * Versão de layout desconhecida é **recusada**, e não lida no palpite: entre
 * versões os campos mudam de posição, e adivinhar trocaria base por valor.
 */

import {
  MAX_LINHAS_SPED,
  type RejectedRecord,
  SpedFormatError,
  centavos,
  competencia,
  data,
  digitos,
  inscricao,
  inteiro,
  numero,
  separar,
  texto,
} from '../shared/sped-campos.js';

export { MAX_LINHAS_SPED, SpedFormatError, type RejectedRecord };

/** Versões de layout cujas posições este parser conhece. */
export const VERSOES_SUPORTADAS = new Set(['005', '006']);

export interface SpedHeader {
  layoutVersion: string;
  cnpj: string;
  /** Competência derivada de `DT_INI`, no formato `YYYY-MM`. */
  period: string;
  companyName: string;
  /** `0` = escrituração original, `1` = retificadora. */
  kind: 'original' | 'retificadora';
}

export interface SpedDocument {
  /** Índice no arquivo, para apontar a linha na recusa. */
  line: number;
  /** `0` = entrada, `1` = saída. Só a entrada gera crédito. */
  operation: 'inbound' | 'outbound';
  model: string;
  accessKey: string | null;
  documentNumber: string | null;
  issuedAt: string | null;
  totalCents: number;
  items: SpedDocumentItem[];
}

export interface SpedDocumentItem {
  itemNumber: number;
  code: string;
  cfop: string;
  totalCents: number;
  pis: SpedTaxLine;
  cofins: SpedTaxLine;
}

export interface SpedTaxLine {
  cst: string;
  baseCents: number;
  rate: number;
  amountCents: number;
}

/** Crédito apurado no período (M100 para PIS, M500 para Cofins). */
export interface SpedApuredCredit {
  tax: 'pis' | 'cofins';
  creditCode: string;
  /** `0` = mercado interno, `1` = exportação, conforme `IND_CRED_ORI`. */
  origin: string;
  baseCents: number;
  rate: number;
  creditCents: number;
  availableCents: number;
  balanceCents: number;
}

/** Saldo credor de períodos anteriores (1100 para PIS, 1500 para Cofins). */
export interface SpedCarriedCredit {
  tax: 'pis' | 'cofins';
  /** Competência de origem do crédito, `YYYY-MM`. */
  originPeriod: string;
  creditCode: string;
  origin: string;
  apuredCents: number;
  availableCents: number;
  usedCents: number;
  refundedCents: number;
  finalBalanceCents: number;
}

export interface SpedResult {
  header: SpedHeader;
  documents: SpedDocument[];
  apuredCredits: SpedApuredCredit[];
  carriedCredits: SpedCarriedCredit[];
  rejected: RejectedRecord[];
  /** Registros lidos por tipo, para o usuário conferir o que entrou. */
  counts: Record<string, number>;
}


export function parseSped(conteudo: string): SpedResult {
  const linhas = conteudo.split(/\r?\n/);

  if (linhas.length > MAX_LINHAS_SPED) {
    throw new SpedFormatError(
      `Arquivo com ${linhas.length} linhas; o limite é ${MAX_LINHAS_SPED}.`,
    );
  }

  const rejected: RejectedRecord[] = [];
  const counts: Record<string, number> = {};
  const documents: SpedDocument[] = [];
  const apuredCredits: SpedApuredCredit[] = [];
  const carriedCredits: SpedCarriedCredit[] = [];

  let header: SpedHeader | undefined;
  let documentoAberto: SpedDocument | undefined;

  for (let i = 0; i < linhas.length; i++) {
    const campos = separar(linhas[i]!);
    if (campos === undefined) {
      continue;
    }

    const registro = campos[1] ?? '';
    counts[registro] = (counts[registro] ?? 0) + 1;

    /**
     * Falha no `0000` **aborta a leitura**, e não entra em `rejected`: o
     * cabeçalho é estrutural. Engoli-lo fazia o usuário receber "arquivo sem
     * registro 0000" no lugar da causa real — versão não suportada, CNPJ
     * malformado — que é a informação de que ele precisa.
     */
    if (registro === '0000') {
      header = lerAbertura(campos);
      continue;
    }

    try {
      switch (registro) {
        case 'C100':
          documentoAberto = lerDocumento(campos, i + 1);
          documents.push(documentoAberto);
          break;
        case 'C170':
          if (documentoAberto === undefined) {
            throw new Error('Item C170 fora de um documento C100.');
          }
          documentoAberto.items.push(lerItem(campos));
          break;
        case 'M100':
          apuredCredits.push(lerCreditoApurado(campos, 'pis'));
          break;
        case 'M500':
          apuredCredits.push(lerCreditoApurado(campos, 'cofins'));
          break;
        case '1100':
          carriedCredits.push(lerSaldoCredor(campos, 'pis'));
          break;
        case '1500':
          carriedCredits.push(lerSaldoCredor(campos, 'cofins'));
          break;
        default:
          break;
      }
    } catch (causa) {
      rejected.push({
        line: i + 1,
        record: registro,
        reason: causa instanceof Error ? causa.message : String(causa),
      });
    }
  }

  if (header === undefined) {
    throw new SpedFormatError(
      'Arquivo sem registro 0000. Não é uma EFD-Contribuições, ou o cabeçalho foi ' +
        'perdido — e sem ele não se sabe de que CNPJ nem de que competência é a ' +
        'escrituração.',
    );
  }

  return { header, documents, apuredCredits, carriedCredits, rejected, counts };
}

function lerAbertura(campos: readonly string[]): SpedHeader {
  const versao = texto(campos[2]);

  if (!VERSOES_SUPORTADAS.has(versao)) {
    throw new SpedFormatError(
      `Versão de layout '${versao}' não suportada (conhecidas: ` +
        `${[...VERSOES_SUPORTADAS].join(', ')}). Entre versões os campos mudam de ` +
        'posição, e ler no palpite trocaria base por valor.',
    );
  }

  const tipo = texto(campos[3]);
  const inicio = data(campos[6], 'DT_INI');
  const cnpj = inscricao(campos[9], 'CNPJ');

  return {
    layoutVersion: versao,
    cnpj,
    period: inicio.slice(0, 7),
    companyName: texto(campos[8]),
    kind: tipo === '1' ? 'retificadora' : 'original',
  };
}

/**
 * C100 — campos do layout: 2 `IND_OPER`, 5 `COD_MOD`, 8 `NUM_DOC`, 9 `CHV_NFE`,
 * 10 `DT_DOC`, 12 `VL_DOC`.
 */
function lerDocumento(campos: readonly string[], line: number): SpedDocument {
  const chave = texto(campos[9]);

  return {
    line,
    // `IND_OPER`: 0 = entrada/aquisição, 1 = saída/prestação.
    operation: texto(campos[2]) === '1' ? 'outbound' : 'inbound',
    model: texto(campos[5]),
    // Documento sem chave existe (nota em papel), e não é erro: entra sem chave
    // e o dossiê o classifica como não conferível por falta de chave.
    accessKey: chave.length === 0 ? null : digitos(campos[9], 44, 'CHV_NFE'),
    documentNumber: texto(campos[8]) === '' ? null : texto(campos[8]),
    issuedAt: texto(campos[10]) === '' ? null : data(campos[10], 'DT_DOC'),
    totalCents: centavos(campos[12], 'VL_DOC'),
    items: [],
  };
}

/**
 * C170 — campos do layout: 2 `NUM_ITEM`, 3 `COD_ITEM`, 7 `VL_ITEM`, 11 `CFOP`,
 * 25 `CST_PIS`, 26 `VL_BC_PIS`, 27 `ALIQ_PIS`, 30 `VL_PIS`, 31 `CST_COFINS`,
 * 32 `VL_BC_COFINS`, 33 `ALIQ_COFINS`, 36 `VL_COFINS`.
 */
function lerItem(campos: readonly string[]): SpedDocumentItem {
  return {
    itemNumber: inteiro(campos[2], 'NUM_ITEM'),
    code: texto(campos[3]),
    cfop: texto(campos[11]),
    totalCents: centavos(campos[7], 'VL_ITEM'),
    pis: {
      cst: texto(campos[25]),
      baseCents: centavos(campos[26], 'VL_BC_PIS'),
      rate: numero(campos[27], 'ALIQ_PIS'),
      amountCents: centavos(campos[30], 'VL_PIS'),
    },
    cofins: {
      cst: texto(campos[31]),
      baseCents: centavos(campos[32], 'VL_BC_COFINS'),
      rate: numero(campos[33], 'ALIQ_COFINS'),
      amountCents: centavos(campos[36], 'VL_COFINS'),
    },
  };
}

function lerCreditoApurado(
  campos: readonly string[],
  tax: 'pis' | 'cofins',
): SpedApuredCredit {
  return {
    tax,
    creditCode: texto(campos[2]),
    origin: texto(campos[3]),
    baseCents: centavos(campos[4], 'VL_BC'),
    rate: numero(campos[5], 'ALIQ'),
    creditCents: centavos(campos[8], 'VL_CRED'),
    availableCents: centavos(campos[12], 'VL_CRED_DISP'),
    balanceCents: centavos(campos[15], 'SLD_CRED'),
  };
}

function lerSaldoCredor(
  campos: readonly string[],
  tax: 'pis' | 'cofins',
): SpedCarriedCredit {
  return {
    tax,
    originPeriod: competencia(campos[2], 'PER_APU_CRED'),
    origin: texto(campos[3]),
    creditCode: texto(campos[5]),
    apuredCents: centavos(campos[6], 'VL_CRED_APU'),
    availableCents: centavos(campos[12], 'SD_CRED_DISP_EFD'),
    usedCents: centavos(campos[13], 'VL_CRED_DESC_EFD'),
    refundedCents: centavos(campos[15], 'VL_CRED_DCOMP_EFD'),
    finalBalanceCents: centavos(campos[18], 'SLD_CRED_FIM'),
  };
}
