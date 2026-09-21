import type { ComparableLine, Direction } from './divergence-analysis.js';

/**
 * Leitura da proposta do Fisco em CSV.
 *
 * **O layout é nosso, não da RFB.** O formato oficial de exposição da apuração
 * assistida ainda está em piloto (Portaria RE 013/2026 RS, citada no briefing e
 * não conferida em texto oficial). Enquanto isso, o caminho de menor risco é o
 * upload manual com um layout documentado: quando o formato oficial sair, entra
 * outro parser e o resto do módulo não muda.
 *
 * Duas colunas no cabeçalho decidem o modo:
 *
 * - com `chave_acesso`, a proposta é **nota a nota** e a comparação acontece;
 * - sem ela, é **só totais** por tributo, e a comparação nota a nota não é
 *   possível. O resultado tem de dizer isso em vez de reportar zero divergências.
 */

export interface UploadResult {
  lines: ComparableLine[];
  totals: Record<string, number>;
  lineLevel: boolean;
  rejected: RejectedRow[];
}

export interface RejectedRow {
  /** Número da linha no arquivo, contando o cabeçalho como 1. */
  row: number;
  reason: string;
  content: string;
}

export class UploadFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadFormatError';
  }
}

const COLUNAS_DE_LINHA = ['chave_acesso', 'item', 'tributo', 'sentido', 'base', 'aliquota', 'valor'];
const COLUNAS_DE_TOTAL = ['tributo', 'valor'];

/** Linhas por upload. Acima disso o arquivo não é uma proposta de um CNPJ. */
export const MAX_LINHAS_UPLOAD = 200_000;

export function parseFiscoUpload(conteudo: string): UploadResult {
  const linhas = conteudo
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (linhas.length === 0) {
    throw new UploadFormatError('Arquivo vazio.');
  }

  // Delimitador decidido uma vez, pelo cabeçalho. Decidir linha por linha
  // deixaria um arquivo com decimal em vírgula alternar de separador no meio.
  const delimitador = linhas[0]!.includes(';') ? ';' : ',';
  const cabecalho = separar(linhas[0]!, delimitador).map((c) => normalizarColuna(c));
  const modo = detectarModo(cabecalho);

  if (linhas.length - 1 > MAX_LINHAS_UPLOAD) {
    throw new UploadFormatError(
      `Arquivo com ${linhas.length - 1} linhas; o limite por proposta é ${MAX_LINHAS_UPLOAD}.`,
    );
  }

  const indice = new Map(cabecalho.map((coluna, i) => [coluna, i]));
  const resultado: UploadResult = {
    lines: [],
    totals: {},
    lineLevel: modo === 'linha',
    rejected: [],
  };

  for (let i = 1; i < linhas.length; i++) {
    const bruto = linhas[i]!;
    try {
      const campos = separar(bruto, delimitador);

      // Contagem diferente do cabeçalho desloca as colunas, e o que sai é um
      // número lido da coluna errada — pior do que uma linha recusada, porque
      // entra na comparação com cara de válido.
      if (campos.length !== cabecalho.length) {
        throw new Error(
          `Linha com ${campos.length} campos; o cabeçalho tem ${cabecalho.length}. ` +
            `Confira se algum valor contém o separador '${delimitador}'.`,
        );
      }

      aplicar(resultado, campos, indice, modo);
    } catch (causa) {
      resultado.rejected.push({
        row: i + 1,
        reason: causa instanceof Error ? causa.message : String(causa),
        content: bruto.slice(0, 200),
      });
    }
  }

  return resultado;
}

function detectarModo(cabecalho: readonly string[]): 'linha' | 'total' {
  const presentes = new Set(cabecalho);

  if (presentes.has('chave_acesso')) {
    const faltando = COLUNAS_DE_LINHA.filter((c) => !presentes.has(c));
    if (faltando.length > 0) {
      throw new UploadFormatError(
        `Proposta nota a nota sem as colunas: ${faltando.join(', ')}. ` +
          `Cabeçalho esperado: ${COLUNAS_DE_LINHA.join(';')}`,
      );
    }
    return 'linha';
  }

  const faltando = COLUNAS_DE_TOTAL.filter((c) => !presentes.has(c));
  if (faltando.length > 0) {
    throw new UploadFormatError(
      'Cabeçalho não reconhecido. Use ' +
        `${COLUNAS_DE_LINHA.join(';')} para a proposta nota a nota, ou ` +
        `${COLUNAS_DE_TOTAL.join(';')} para a proposta só de totais.`,
    );
  }

  return 'total';
}

function aplicar(
  resultado: UploadResult,
  campos: readonly string[],
  indice: Map<string, number>,
  modo: 'linha' | 'total',
): void {
  const ler = (coluna: string): string => (campos[indice.get(coluna)!] ?? '').trim();

  const tributo = ler('tributo').toLowerCase();
  if (tributo.length === 0) {
    throw new Error('Tributo vazio.');
  }

  const valor = paraCentavos(ler('valor'), 'valor');

  if (modo === 'total') {
    // Somado, e não substituído: uma proposta pode trazer o tributo em mais de
    // uma linha, e sobrescrever perderia a primeira em silêncio.
    resultado.totals[tributo] = (resultado.totals[tributo] ?? 0) + valor;
    return;
  }

  const linha: ComparableLine = {
    accessKey: chaveDeAcesso(ler('chave_acesso')),
    line: item(ler('item')),
    tax: tributo,
    direction: sentido(ler('sentido')),
    baseCents: paraCentavos(ler('base'), 'base'),
    rate: aliquota(ler('aliquota')),
    amountCents: valor,
  };

  resultado.lines.push(linha);
  resultado.totals[tributo] = (resultado.totals[tributo] ?? 0) + valor;
}

// -------------------------------------------------------------- campos

function chaveDeAcesso(bruto: string): string {
  const digitos = bruto.replace(/\D/g, '');
  if (digitos.length !== 44) {
    throw new Error(`Chave de acesso com ${digitos.length} dígitos; esperado 44.`);
  }
  return digitos;
}

function item(bruto: string): number {
  const numero = Number.parseInt(bruto, 10);
  if (!Number.isInteger(numero) || numero < 1) {
    throw new Error(`Número de item inválido: '${bruto}'.`);
  }
  return numero;
}

function sentido(bruto: string): Direction {
  const normalizado = bruto.toLowerCase();
  if (['s', 'saida', 'saída', 'outbound'].includes(normalizado)) {
    return 'outbound';
  }
  if (['e', 'entrada', 'inbound'].includes(normalizado)) {
    return 'inbound';
  }
  // Não há padrão razoável: assumir saída transformaria crédito em débito, e
  // assumir entrada faria o contrário. O sentido decide o significado inteiro
  // da divergência.
  throw new Error(`Sentido não reconhecido: '${bruto}'. Use E/S, entrada/saida.`);
}

function aliquota(bruto: string): number {
  if (bruto.length === 0) {
    return 0;
  }

  const numero = Number(normalizarDecimal(bruto, 'alíquota'));
  if (!Number.isFinite(numero) || numero < 0 || numero > 100) {
    throw new Error(`Alíquota fora de 0 a 100: '${bruto}'.`);
  }
  return numero;
}

/**
 * Valor monetário em centavos.
 *
 * Converte pela string e não por `Math.round(Number(x) * 100)`: o segundo erra
 * centavos em valores grandes por representação binária, e num arquivo de
 * comparação fiscal cada centavo errado vira uma divergência falsa.
 */
function paraCentavos(bruto: string, campo: string): number {
  if (bruto.length === 0) {
    return 0;
  }

  const normalizado = normalizarDecimal(bruto, campo);
  const negativo = normalizado.startsWith('-');
  const [inteiro = '0', decimal = ''] = normalizado.replace('-', '').split('.');

  if (decimal.length > 2) {
    throw new Error(`Campo ${campo} com mais de duas casas decimais: '${bruto}'.`);
  }

  const centavos = Number(inteiro) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(centavos)) {
    throw new Error(`Campo ${campo} fora da faixa representável: '${bruto}'.`);
  }

  return negativo ? -centavos : centavos;
}

/**
 * Resolve o separador decimal, e **recusa o ambíguo**.
 *
 * `1.000` pode ser mil (pt-BR) ou um (en-US). Adivinhar erraria por mil vezes
 * num campo de dinheiro, e a divergência falsa resultante levaria o contador a
 * contestar o que estava certo. Recusar custa ao usuário reescrever o campo com
 * duas casas decimais.
 */
function normalizarDecimal(bruto: string, campo: string): string {
  const limpo = bruto.replace(/\s|R\$|%/g, '');

  if (!/^-?[\d.,]+$/.test(limpo)) {
    throw new Error(`Campo ${campo} não é numérico: '${bruto}'.`);
  }

  const ultimoPonto = limpo.lastIndexOf('.');
  const ultimaVirgula = limpo.lastIndexOf(',');

  if (ultimoPonto >= 0 && ultimaVirgula >= 0) {
    // O separador decimal é o último dos dois; o outro é de milhar.
    return ultimaVirgula > ultimoPonto
      ? limpo.replace(/\./g, '').replace(',', '.')
      : limpo.replace(/,/g, '');
  }

  if (ultimaVirgula >= 0) {
    return limpo.replace(',', '.');
  }

  if (ultimoPonto >= 0) {
    const casas = limpo.length - ultimoPonto - 1;
    if (casas === 3 && ultimoPonto > 0) {
      throw new Error(
        `Campo ${campo} ambíguo: '${bruto}' pode ser milhar ou decimal. ` +
          'Escreva com duas casas decimais (1000.00 ou 1.000,00).',
      );
    }
    return limpo;
  }

  return limpo;
}

/** Ponto e vírgula por padrão, porque é o que o Excel pt-BR exporta. */
function separar(linha: string, delimitador: string): string[] {
  return linha.split(delimitador);
}

function normalizarColuna(bruto: string): string {
  return bruto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_');
}
