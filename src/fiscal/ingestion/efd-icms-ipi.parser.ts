/**
 * Leitor de EFD ICMS/IPI.
 *
 * Escrituração estadual, irmã da EFD-Contribuições e **de leiaute diferente**.
 * Há um leitor separado em `dossier/sped-parser.ts`, e são dois de propósito:
 * misturá-los seria o erro mais caro possível aqui, porque os dois arquivos se
 * parecem o bastante para um ler o outro sem reclamar.
 *
 * O registro `0000` é onde a diferença morde. Nos dois leiautes ele existe, tem
 * `COD_VER` no campo 02, e daí em diante diverge:
 *
 * | Campo | EFD ICMS/IPI | EFD-Contribuições |
 * |-------|--------------|-------------------|
 * | 04    | `DT_INI`     | `IND_SIT_ESP`     |
 * | 06    | `NOME`       | `DT_INI`          |
 * | 07    | `CNPJ`       | `DT_FIN`          |
 * | 09    | `UF`         | `CNPJ`            |
 *
 * Ler um com as posições do outro não dá erro de parse: dá CNPJ onde era data e
 * competência onde era nome. Por isso cada leitor recusa a versão de leiaute que
 * não conhece, em vez de tentar.
 *
 * | Registro | O que traz |
 * |----------|------------|
 * | `0000`   | versão do leiaute, CNPJ, UF e período da escrituração |
 * | `C100`   | documento fiscal, com situação e totais de ICMS e IPI |
 * | `C170`   | item do documento, com CST, base, alíquota e valor de ICMS e IPI |
 * | `C190`   | consolidação analítica do documento por CST × CFOP × alíquota |
 * | `E110`   | apuração do ICMS do período |
 * | `E520`   | apuração do IPI do período |
 *
 * **Procedência das posições.** Nenhuma foi escrita de memória. Todas saíram do
 * Guia Prático EFD-ICMS/IPI versão 3.2.2 (11/02/2026), extraídas pelo script
 * `scripts/extrair-layout-efd.ts`, e conferidas contra a Nota Técnica 2026.001
 * v1.0. Ao mexer neste arquivo, rode o script de novo — não confie no que está
 * escrito aqui, nem no que você lembra.
 */
import {
  MAX_LINHAS_SPED,
  type RejectedRecord,
  SpedFormatError,
  centavos,
  data,
  inteiro,
  numero,
  separar,
  texto,
} from '../shared/sped-campos.js';

export { MAX_LINHAS_SPED, SpedFormatError, type RejectedRecord };

/**
 * Códigos de versão de leiaute cujas posições este leitor conhece.
 *
 * `020` é o leiaute 119, obrigatório desde 01/01/2026, que é o documentado pelo
 * Guia Prático 3.2.2 contra o qual estas posições foram conferidas.
 *
 * O `021` (leiaute 120, obrigatório em 01/01/2027) **não** está aqui, embora a
 * conferência do `0000` e do `C170` contra a Nota Técnica 2026.001 tenha dado
 * posições idênticas: a conferência foi parcial, e "parcial" não é conferido.
 * O `019` e anteriores também não — ler a EFD de 2025 exige o guia de 2025, que
 * o script de extração agora torna barato conferir.
 *
 * Aceitar uma versão sem conferir o guia dela é o único jeito de este leitor
 * produzir um número errado em silêncio, e é por isso que a lista é curta.
 */
export const VERSOES_EFD_ICMS_SUPORTADAS = new Set(['020']);

export interface EfdIcmsHeader {
  layoutVersion: string;
  /**
   * 14 posições. Desde o leiaute 020 o campo é do tipo caractere, não numérico,
   * para acomodar o CNPJ alfanumérico — guardar só dígitos passaria a perder
   * informação.
   */
  cnpj: string;
  uf: string;
  stateRegistration: string;
  /** Competência derivada de `DT_INI`, no formato `YYYY-MM`. */
  period: string;
  companyName: string;
  /** `0` = escrituração original, `1` = retificadora. */
  kind: 'original' | 'retificadora';
}

export interface EfdIcmsDocument {
  /** Índice no arquivo, para apontar a linha na recusa. */
  line: number;
  operation: 'inbound' | 'outbound';
  /** `0` = emissão própria, `1` = emissão de terceiros. */
  issuedBySelf: boolean;
  model: string;
  /**
   * `COD_SIT` cru. `02` e `03` são documento cancelado e `04` é denegado — quem
   * apura precisa saber disso, e por isso o código vem inteiro em vez de virar
   * um booleano que esconde qual dos casos é.
   */
  situation: string;
  accessKey: string | null;
  documentNumber: string | null;
  issuedAt: string | null;
  totalCents: number;
  icmsBaseCents: number;
  icmsCents: number;
  icmsStBaseCents: number;
  icmsStCents: number;
  ipiCents: number;
  items: EfdIcmsItem[];
  analytics: EfdIcmsAnalytic[];
}

export interface EfdIcmsItem {
  itemNumber: number;
  code: string;
  cfop: string;
  totalCents: number;
  icms: EfdIcmsTaxLine;
  ipi: EfdIcmsTaxLine;
}

export interface EfdIcmsTaxLine {
  cst: string;
  baseCents: number;
  rate: number;
  amountCents: number;
}

/** C190 — o que o Fisco soma. Confrontar com a soma dos C170 é uma trilha. */
export interface EfdIcmsAnalytic {
  cstIcms: string;
  cfop: string;
  icmsRate: number;
  operationCents: number;
  icmsBaseCents: number;
  icmsCents: number;
  icmsStBaseCents: number;
  icmsStCents: number;
  reducedBaseCents: number;
  ipiCents: number;
}

/** E110 — apuração do ICMS do período. */
export interface EfdIcmsAssessment {
  totalDebitsCents: number;
  /** `VL_AJ_DEBITOS` — ajustes que vêm do próprio documento fiscal. */
  documentDebitAdjustmentsCents: number;
  adjustmentDebitsCents: number;
  creditReversalsCents: number;
  totalCreditsCents: number;
  /** `VL_AJ_CREDITOS` — ajustes que vêm do próprio documento fiscal. */
  documentCreditAdjustmentsCents: number;
  adjustmentCreditsCents: number;
  debitReversalsCents: number;
  previousCreditBalanceCents: number;
  assessedBalanceCents: number;
  deductionsCents: number;
  icmsPayableCents: number;
  carriedCreditBalanceCents: number;
  extraAssessmentCents: number;
}

/** E520 — apuração do IPI do período. */
export interface EfdIpiAssessment {
  previousCreditBalanceCents: number;
  debitsCents: number;
  creditsCents: number;
  otherDebitsCents: number;
  otherCreditsCents: number;
  carriedCreditBalanceCents: number;
  ipiPayableCents: number;
}

export interface EfdIcmsResult {
  header: EfdIcmsHeader;
  documents: EfdIcmsDocument[];
  /**
   * `null` quando o arquivo não traz `E110`. Não é zero: ausência de apuração e
   * apuração zerada são coisas diferentes, e confundi-las faria o sistema
   * afirmar "nada a recolher" sobre um arquivo que simplesmente não diz.
   */
  icmsAssessment: EfdIcmsAssessment | null;
  /** `null` quando o arquivo não traz `E520`, pelo mesmo motivo. */
  ipiAssessment: EfdIpiAssessment | null;
  rejected: RejectedRecord[];
  /** Registros lidos por tipo, para o usuário conferir o que entrou. */
  counts: Record<string, number>;
}

export function parseEfdIcmsIpi(conteudo: string): EfdIcmsResult {
  const linhas = conteudo.split(/\r?\n/);

  if (linhas.length > MAX_LINHAS_SPED) {
    throw new SpedFormatError(
      `Arquivo com ${linhas.length} linhas; o limite é ${MAX_LINHAS_SPED}.`,
    );
  }

  const rejected: RejectedRecord[] = [];
  const counts: Record<string, number> = {};
  const documents: EfdIcmsDocument[] = [];

  let header: EfdIcmsHeader | undefined;
  let icmsAssessment: EfdIcmsAssessment | null = null;
  let ipiAssessment: EfdIpiAssessment | null = null;
  let documentoAberto: EfdIcmsDocument | undefined;

  for (let i = 0; i < linhas.length; i++) {
    const campos = separar(linhas[i]!);
    if (campos === undefined) {
      continue;
    }

    const registro = campos[1] ?? '';
    counts[registro] = (counts[registro] ?? 0) + 1;

    // Falha no `0000` aborta a leitura, e não entra em `rejected`: o cabeçalho é
    // estrutural, e engoli-lo faria o usuário receber "arquivo sem registro
    // 0000" no lugar da causa real — versão não suportada, leiaute trocado.
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
          exigirDocumento(documentoAberto, 'C170').items.push(lerItem(campos));
          break;
        case 'C190':
          exigirDocumento(documentoAberto, 'C190').analytics.push(lerAnalitico(campos));
          break;
        case 'E110':
          icmsAssessment = lerApuracaoIcms(campos);
          break;
        case 'E520':
          ipiAssessment = lerApuracaoIpi(campos);
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
      'Arquivo sem registro 0000. Não é uma EFD ICMS/IPI, ou o cabeçalho foi ' +
        'perdido — e sem ele não se sabe de que CNPJ nem de que competência é a ' +
        'escrituração.',
    );
  }

  return { header, documents, icmsAssessment, ipiAssessment, rejected, counts };
}

function exigirDocumento(
  aberto: EfdIcmsDocument | undefined,
  registro: string,
): EfdIcmsDocument {
  if (aberto === undefined) {
    throw new Error(`Registro ${registro} fora de um documento C100.`);
  }
  return aberto;
}

/**
 * `0000` — campos do leiaute: 2 `COD_VER`, 3 `COD_FIN`, 4 `DT_INI`, 6 `NOME`,
 * 7 `CNPJ`, 9 `UF`, 10 `IE`.
 */
function lerAbertura(campos: readonly string[]): EfdIcmsHeader {
  const versao = texto(campos[2]);

  if (!VERSOES_EFD_ICMS_SUPORTADAS.has(versao)) {
    throw new SpedFormatError(
      `Versão de leiaute '${versao}' não suportada (conhecidas: ` +
        `${[...VERSOES_EFD_ICMS_SUPORTADAS].join(', ')}). Entre versões os campos ` +
        'mudam de posição, e ler no palpite trocaria base por valor.',
    );
  }

  const tipo = texto(campos[3]);
  const inicio = data(campos[4], 'DT_INI');

  return {
    layoutVersion: versao,
    cnpj: inscricao(campos[7]),
    uf: sigla(campos[9]),
    stateRegistration: texto(campos[10]),
    period: inicio.slice(0, 7),
    companyName: texto(campos[6]),
    kind: tipo === '1' ? 'retificadora' : 'original',
  };
}

/**
 * `C100` — campos do leiaute: 2 `IND_OPER`, 3 `IND_EMIT`, 5 `COD_MOD`,
 * 6 `COD_SIT`, 8 `NUM_DOC`, 9 `CHV_NFE`, 10 `DT_DOC`, 12 `VL_DOC`,
 * 21 `VL_BC_ICMS`, 22 `VL_ICMS`, 23 `VL_BC_ICMS_ST`, 24 `VL_ICMS_ST`, 25 `VL_IPI`.
 */
function lerDocumento(campos: readonly string[], linha: number): EfdIcmsDocument {
  const chave = texto(campos[9]);
  const emissao = texto(campos[10]);
  const numero44 = chave.length === 0 ? null : chaveDeAcesso(chave);

  return {
    line: linha,
    operation: texto(campos[2]) === '1' ? 'outbound' : 'inbound',
    issuedBySelf: texto(campos[3]) === '0',
    model: texto(campos[5]),
    situation: texto(campos[6]),
    accessKey: numero44,
    documentNumber: texto(campos[8]) === '' ? null : texto(campos[8]),
    issuedAt: emissao === '' ? null : data(campos[10], 'DT_DOC'),
    totalCents: centavos(campos[12], 'VL_DOC'),
    icmsBaseCents: centavos(campos[21], 'VL_BC_ICMS'),
    icmsCents: centavos(campos[22], 'VL_ICMS'),
    icmsStBaseCents: centavos(campos[23], 'VL_BC_ICMS_ST'),
    icmsStCents: centavos(campos[24], 'VL_ICMS_ST'),
    ipiCents: centavos(campos[25], 'VL_IPI'),
    items: [],
    analytics: [],
  };
}

/**
 * `C170` — campos do leiaute: 2 `NUM_ITEM`, 3 `COD_ITEM`, 7 `VL_ITEM`,
 * 10 `CST_ICMS`, 11 `CFOP`, 13 `VL_BC_ICMS`, 14 `ALIQ_ICMS`, 15 `VL_ICMS`,
 * 20 `CST_IPI`, 22 `VL_BC_IPI`, 23 `ALIQ_IPI`, 24 `VL_IPI`.
 */
function lerItem(campos: readonly string[]): EfdIcmsItem {
  return {
    itemNumber: inteiro(campos[2], 'NUM_ITEM'),
    code: texto(campos[3]),
    cfop: texto(campos[11]),
    totalCents: centavos(campos[7], 'VL_ITEM'),
    icms: {
      cst: texto(campos[10]),
      baseCents: centavos(campos[13], 'VL_BC_ICMS'),
      rate: numero(campos[14], 'ALIQ_ICMS'),
      amountCents: centavos(campos[15], 'VL_ICMS'),
    },
    ipi: {
      cst: texto(campos[20]),
      baseCents: centavos(campos[22], 'VL_BC_IPI'),
      rate: numero(campos[23], 'ALIQ_IPI'),
      amountCents: centavos(campos[24], 'VL_IPI'),
    },
  };
}

/**
 * `C190` — campos do leiaute: 2 `CST_ICMS`, 3 `CFOP`, 4 `ALIQ_ICMS`, 5 `VL_OPR`,
 * 6 `VL_BC_ICMS`, 7 `VL_ICMS`, 8 `VL_BC_ICMS_ST`, 9 `VL_ICMS_ST`, 10 `VL_RED_BC`,
 * 11 `VL_IPI`.
 */
function lerAnalitico(campos: readonly string[]): EfdIcmsAnalytic {
  return {
    cstIcms: texto(campos[2]),
    cfop: texto(campos[3]),
    icmsRate: numero(campos[4], 'ALIQ_ICMS'),
    operationCents: centavos(campos[5], 'VL_OPR'),
    icmsBaseCents: centavos(campos[6], 'VL_BC_ICMS'),
    icmsCents: centavos(campos[7], 'VL_ICMS'),
    icmsStBaseCents: centavos(campos[8], 'VL_BC_ICMS_ST'),
    icmsStCents: centavos(campos[9], 'VL_ICMS_ST'),
    reducedBaseCents: centavos(campos[10], 'VL_RED_BC'),
    ipiCents: centavos(campos[11], 'VL_IPI'),
  };
}

/** `E110` — campos 2 a 15, na ordem do leiaute. */
function lerApuracaoIcms(campos: readonly string[]): EfdIcmsAssessment {
  return {
    totalDebitsCents: centavos(campos[2], 'VL_TOT_DEBITOS'),
    documentDebitAdjustmentsCents: centavos(campos[3], 'VL_AJ_DEBITOS'),
    adjustmentDebitsCents: centavos(campos[4], 'VL_TOT_AJ_DEBITOS'),
    creditReversalsCents: centavos(campos[5], 'VL_ESTORNOS_CRED'),
    totalCreditsCents: centavos(campos[6], 'VL_TOT_CREDITOS'),
    documentCreditAdjustmentsCents: centavos(campos[7], 'VL_AJ_CREDITOS'),
    adjustmentCreditsCents: centavos(campos[8], 'VL_TOT_AJ_CREDITOS'),
    debitReversalsCents: centavos(campos[9], 'VL_ESTORNOS_DEB'),
    previousCreditBalanceCents: centavos(campos[10], 'VL_SLD_CREDOR_ANT'),
    assessedBalanceCents: centavos(campos[11], 'VL_SLD_APURADO'),
    deductionsCents: centavos(campos[12], 'VL_TOT_DED'),
    icmsPayableCents: centavos(campos[13], 'VL_ICMS_RECOLHER'),
    carriedCreditBalanceCents: centavos(campos[14], 'VL_SLD_CREDOR_TRANSPORTAR'),
    extraAssessmentCents: centavos(campos[15], 'DEB_ESP'),
  };
}

/** `E520` — campos 2 a 8, na ordem do leiaute. */
function lerApuracaoIpi(campos: readonly string[]): EfdIpiAssessment {
  return {
    previousCreditBalanceCents: centavos(campos[2], 'VL_SD_ANT_IPI'),
    debitsCents: centavos(campos[3], 'VL_DEB_IPI'),
    creditsCents: centavos(campos[4], 'VL_CRED_IPI'),
    otherDebitsCents: centavos(campos[5], 'VL_OD_IPI'),
    otherCreditsCents: centavos(campos[6], 'VL_OC_IPI'),
    carriedCreditBalanceCents: centavos(campos[7], 'VL_SC_IPI'),
    ipiPayableCents: centavos(campos[8], 'VL_SD_IPI'),
  };
}

// ----------------------------------------------------------------- campos

/**
 * CNPJ da escrituração, 14 posições.
 *
 * Não filtra para dígitos. A partir do leiaute 020 o campo passou de numérico
 * para caractere, porque o CNPJ alfanumérico usa letras nas 12 primeiras
 * posições; jogar fora o que não é dígito devolveria um CNPJ curto e errado.
 */
function inscricao(bruto: string | undefined): string {
  const limpo = texto(bruto).toUpperCase().replace(/[^0-9A-Z]/g, '');

  if (limpo.length !== 14) {
    throw new SpedFormatError(
      `Campo CNPJ do registro 0000 com ${limpo.length} posições; esperado 14. ` +
        'Sem CNPJ íntegro não se sabe de quem é a escrituração.',
    );
  }

  return limpo;
}

function sigla(bruto: string | undefined): string {
  const limpo = texto(bruto).toUpperCase();

  if (!/^[A-Z]{2}$/.test(limpo)) {
    throw new SpedFormatError(
      `Campo UF do registro 0000 inválido: '${limpo}'. A EFD ICMS/IPI é estadual, ` +
        'e sem a UF não se sabe qual legislação aplicar.',
    );
  }

  return limpo;
}

function chaveDeAcesso(bruto: string): string {
  const limpo = bruto.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');

  if (limpo.length !== 44) {
    throw new Error(`Campo CHV_NFE com ${limpo.length} posições; esperado 44.`);
  }

  return limpo;
}
