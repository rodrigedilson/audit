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

export interface RejectedRecord {
  line: number;
  record: string;
  reason: string;
}

export class SpedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpedFormatError';
  }
}

/** Linhas por arquivo. Uma EFD de um CNPJ não passa disso. */
export const MAX_LINHAS_SPED = 2_000_000;

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

/**
 * Linha do SPED: `|REG|campo|campo|`.
 *
 * O `split` produz vazio na primeira posição, então `REG` — que é o campo 1 do
 * layout — fica em `campos[1]`, e **o campo N do layout fica em `campos[N]`**.
 *
 * Vale escrever isto porque errar aqui por um é silencioso: a primeira versão
 * deste parser lia tudo em `N + 1`, e o teste, escrito depois, codificou o mesmo
 * deslocamento e passou. Só conferir contra o layout pegou.
 */
function separar(linha: string): string[] | undefined {
  const limpa = linha.trim();
  if (limpa.length === 0 || !limpa.startsWith('|')) {
    return undefined;
  }
  return limpa.split('|');
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
  const cnpj = digitos(campos[9], 14, 'CNPJ');

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

// ----------------------------------------------------------------- campos

function texto(bruto: string | undefined): string {
  return (bruto ?? '').trim();
}

/**
 * Valor monetário, pela string.
 *
 * O SPED usa vírgula decimal e não separador de milhar. Converter por
 * `Number(x) * 100` erraria centavo em valor grande, e num dossiê de crédito
 * cada centavo errado é uma divergência falsa contra a própria escrituração do
 * cliente.
 */
function centavos(bruto: string | undefined, campo: string): number {
  const limpo = texto(bruto);
  if (limpo.length === 0) {
    return 0;
  }

  if (!/^-?\d+(,\d{1,2})?$/.test(limpo)) {
    throw new Error(`Campo ${campo} não é valor SPED válido: '${limpo}'.`);
  }

  const negativo = limpo.startsWith('-');
  const [inteiroParte = '0', decimal = ''] = limpo.replace('-', '').split(',');
  const total = Number(inteiroParte) * 100 + Number(decimal.padEnd(2, '0'));

  if (!Number.isSafeInteger(total)) {
    throw new Error(`Campo ${campo} fora da faixa representável: '${limpo}'.`);
  }

  return negativo ? -total : total;
}

function numero(bruto: string | undefined, campo: string): number {
  const limpo = texto(bruto);
  if (limpo.length === 0) {
    return 0;
  }

  const valor = Number(limpo.replace(',', '.'));
  if (!Number.isFinite(valor)) {
    throw new Error(`Campo ${campo} não é numérico: '${limpo}'.`);
  }
  return valor;
}

function inteiro(bruto: string | undefined, campo: string): number {
  const valor = Number.parseInt(texto(bruto), 10);
  if (!Number.isInteger(valor)) {
    throw new Error(`Campo ${campo} não é inteiro: '${texto(bruto)}'.`);
  }
  return valor;
}

/** `DDMMAAAA`, que é o formato de data do SPED. */
function data(bruto: string | undefined, campo: string): string {
  const limpo = texto(bruto);
  const achado = /^(\d{2})(\d{2})(\d{4})$/.exec(limpo);

  if (!achado) {
    throw new Error(`Campo ${campo} não é data SPED (DDMMAAAA): '${limpo}'.`);
  }

  const [, dia, mes, ano] = achado as unknown as [string, string, string, string];
  if (Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) {
    throw new Error(`Campo ${campo} tem data inválida: '${limpo}'.`);
  }

  return `${ano}-${mes}-${dia}`;
}

/** `MMAAAA`, que é o formato de competência do SPED. */
function competencia(bruto: string | undefined, campo: string): string {
  const limpo = texto(bruto);
  const achado = /^(\d{2})(\d{4})$/.exec(limpo);

  if (!achado) {
    throw new Error(`Campo ${campo} não é competência SPED (MMAAAA): '${limpo}'.`);
  }

  const [, mes, ano] = achado as unknown as [string, string, string];
  if (Number(mes) < 1 || Number(mes) > 12) {
    throw new Error(`Campo ${campo} tem mês inválido: '${limpo}'.`);
  }

  return `${ano}-${mes}`;
}

function digitos(bruto: string | undefined, quantos: number, campo: string): string {
  const so = texto(bruto).replace(/\D/g, '');
  if (so.length !== quantos) {
    throw new Error(`Campo ${campo} com ${so.length} dígitos; esperado ${quantos}.`);
  }
  return so;
}
