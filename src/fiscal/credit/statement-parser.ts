/**
 * Leitura de extrato bancário: OFX e CSV.
 *
 * O extrato é informação fiscal nesta onda, e não financeira: sob split payment
 * o tributo da etapa anterior se extingue na liquidação, então "pagamos ou não
 * pagamos este fornecedor" decide se o crédito de IBS/CBS pode ser aproveitado.
 *
 * O OFX é o formato de menor risco porque todo banco brasileiro exporta, e
 * porque traz o `FITID` — identificador do lançamento. É ele que torna a
 * reimportação idempotente: sem identificador, o mesmo extrato enviado duas
 * vezes dobraria o pagamento, e um crédito apareceria liberado por um pagamento
 * que aconteceu uma vez só.
 */

export interface StatementLine {
  /** `FITID` do OFX, ou uma chave derivada no CSV. Nunca vazio. */
  fitid: string;
  /** `YYYY-MM-DD`. */
  postedAt: string;
  /** Negativo é saída de caixa; pagamento a fornecedor é negativo. */
  amountCents: number;
  description: string;
  /** CNPJ da contraparte, quando o arquivo traz. */
  counterpartyDoc?: string;
}

export interface StatementResult {
  source: 'ofx' | 'csv';
  account?: string;
  periodFrom?: string;
  periodTo?: string;
  lines: StatementLine[];
  rejected: RejectedStatementLine[];
}

export interface RejectedStatementLine {
  reason: string;
  content: string;
}

export class StatementFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementFormatError';
  }
}

/** Lançamentos por arquivo. Acima disso não é o extrato de um CNPJ. */
export const MAX_LANCAMENTOS = 100_000;

export function parseStatement(conteudo: string): StatementResult {
  if (conteudo.trim().length === 0) {
    throw new StatementFormatError('Arquivo vazio.');
  }

  return pareceOfx(conteudo) ? parseOfx(conteudo) : parseCsv(conteudo);
}

/**
 * O OFX é SGML, não XML: tags sem fechamento são a regra, e um parser de XML
 * recusa metade dos arquivos que os bancos emitem de verdade.
 */
function pareceOfx(conteudo: string): boolean {
  return /<OFX>|<STMTTRN>|OFXHEADER/i.test(conteudo);
}

function parseOfx(conteudo: string): StatementResult {
  const transacoes = conteudo.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];

  if (transacoes.length === 0) {
    throw new StatementFormatError(
      'Arquivo OFX sem nenhum bloco <STMTTRN>. Confira se o extrato foi exportado ' +
        'com lançamentos e não apenas com o saldo.',
    );
  }

  if (transacoes.length > MAX_LANCAMENTOS) {
    throw new StatementFormatError(
      `Arquivo com ${transacoes.length} lançamentos; o limite é ${MAX_LANCAMENTOS}.`,
    );
  }

  const lines: StatementLine[] = [];
  const rejected: RejectedStatementLine[] = [];

  for (const bloco of transacoes) {
    try {
      lines.push(lancamentoDoOfx(bloco));
    } catch (causa) {
      rejected.push({
        reason: causa instanceof Error ? causa.message : String(causa),
        content: bloco.replace(/\s+/g, ' ').slice(0, 200),
      });
    }
  }

  const conta = tag(conteudo, 'ACCTID');
  const de = tag(conteudo, 'DTSTART');
  const ate = tag(conteudo, 'DTEND');

  return {
    source: 'ofx',
    ...(conta === undefined ? {} : { account: conta }),
    ...(de === undefined ? {} : { periodFrom: dataDoOfx(de) }),
    ...(ate === undefined ? {} : { periodTo: dataDoOfx(ate) }),
    lines,
    rejected,
  };
}

function lancamentoDoOfx(bloco: string): StatementLine {
  const fitid = tag(bloco, 'FITID');
  if (fitid === undefined || fitid.length === 0) {
    // Sem FITID a reimportação dobraria o lançamento, e o crédito apareceria
    // liberado por um pagamento que aconteceu uma vez só.
    throw new Error('Lançamento sem FITID: não há como evitar importação em duplicidade.');
  }

  const data = tag(bloco, 'DTPOSTED');
  if (data === undefined) {
    throw new Error('Lançamento sem DTPOSTED.');
  }

  const valor = tag(bloco, 'TRNAMT');
  if (valor === undefined) {
    throw new Error('Lançamento sem TRNAMT.');
  }

  const descricao = [tag(bloco, 'NAME'), tag(bloco, 'MEMO')]
    .filter((t): t is string => t !== undefined && t.length > 0)
    .join(' — ');

  const documento = digitos(descricao);

  return {
    fitid,
    postedAt: dataDoOfx(data),
    amountCents: paraCentavos(valor),
    description: descricao,
    ...(documento === undefined ? {} : { counterpartyDoc: documento }),
  };
}

/** Valor do primeiro par `<TAG>valor`, com ou sem fechamento. */
function tag(conteudo: string, nome: string): string | undefined {
  const achado = new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i').exec(conteudo);
  return achado?.[1]?.trim();
}

/** `YYYYMMDD` com sufixo opcional de hora e fuso (`20270915120000[-3:BRT]`). */
function dataDoOfx(bruto: string): string {
  const achado = /^(\d{4})(\d{2})(\d{2})/.exec(bruto.trim());
  if (!achado) {
    throw new Error(`Data OFX inválida: '${bruto}'.`);
  }
  return `${achado[1]}-${achado[2]}-${achado[3]}`;
}

// ---------------------------------------------------------------- CSV

const COLUNAS = ['data', 'valor'] as const;

function parseCsv(conteudo: string): StatementResult {
  const linhas = conteudo
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const delimitador = linhas[0]!.includes(';') ? ';' : ',';
  const cabecalho = linhas[0]!.split(delimitador).map(normalizarColuna);
  const faltando = COLUNAS.filter((c) => !cabecalho.includes(c));

  if (faltando.length > 0) {
    throw new StatementFormatError(
      `Cabeçalho de extrato CSV sem as colunas: ${faltando.join(', ')}. ` +
        'Esperado ao menos `data;valor`, e opcionalmente `historico`, `documento` e `id`.',
    );
  }

  if (linhas.length - 1 > MAX_LANCAMENTOS) {
    throw new StatementFormatError(
      `Arquivo com ${linhas.length - 1} lançamentos; o limite é ${MAX_LANCAMENTOS}.`,
    );
  }

  const indice = new Map(cabecalho.map((coluna, i) => [coluna, i]));
  const lines: StatementLine[] = [];
  const rejected: RejectedStatementLine[] = [];

  for (let i = 1; i < linhas.length; i++) {
    const bruto = linhas[i]!;
    try {
      const campos = bruto.split(delimitador);
      if (campos.length !== cabecalho.length) {
        throw new Error(
          `Linha com ${campos.length} campos; o cabeçalho tem ${cabecalho.length}.`,
        );
      }
      lines.push(lancamentoDoCsv(campos, indice, i));
    } catch (causa) {
      rejected.push({
        reason: causa instanceof Error ? causa.message : String(causa),
        content: bruto.slice(0, 200),
      });
    }
  }

  return { source: 'csv', lines, rejected };
}

function lancamentoDoCsv(
  campos: readonly string[],
  indice: Map<string, number>,
  numeroDaLinha: number,
): StatementLine {
  const ler = (coluna: string): string =>
    (campos[indice.get(coluna) ?? -1] ?? '').trim();

  const data = dataDoCsv(ler('data'));
  const valor = paraCentavos(ler('valor'));
  const descricao = ler('historico');

  /**
   * Sem coluna `id`, a chave é derivada de data, valor, histórico e posição.
   *
   * Incluir a posição é o que impede dois pagamentos idênticos no mesmo dia de
   * colapsarem num só — o que apagaria metade do que saiu do caixa. O custo é
   * que reordenar o arquivo gera chaves novas, e daí a coluna `id` ser o
   * caminho preferido.
   */
  const informado = ler('id');
  const fitid =
    informado.length > 0
      ? informado
      : `csv:${data}:${valor}:${descricao.slice(0, 40)}:${numeroDaLinha}`;

  const documento = digitos(`${ler('documento')} ${descricao}`);

  return {
    fitid,
    postedAt: data,
    amountCents: valor,
    description: descricao,
    ...(documento === undefined ? {} : { counterpartyDoc: documento }),
  };
}

function dataDoCsv(bruto: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bruto);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  const brasileira = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(bruto);
  if (brasileira) {
    return `${brasileira[3]}-${brasileira[2]}-${brasileira[1]}`;
  }

  throw new Error(`Data inválida: '${bruto}'. Use AAAA-MM-DD ou DD/MM/AAAA.`);
}

/**
 * Valor em centavos, pela string.
 *
 * Mesma razão do parser da proposta do Fisco: `Math.round(x * 100)` erra centavo
 * em valor grande, e `1.000` é ambíguo entre mil e um — num extrato, errar por
 * mil vezes faria o casamento apontar a nota errada.
 */
function paraCentavos(bruto: string): number {
  const limpo = bruto.replace(/\s|R\$/g, '');

  if (!/^-?\+?[\d.,]+$/.test(limpo.replace('+', ''))) {
    throw new Error(`Valor não numérico: '${bruto}'.`);
  }

  const negativo = limpo.startsWith('-');
  const semSinal = limpo.replace(/^[+-]/, '');

  const ultimoPonto = semSinal.lastIndexOf('.');
  const ultimaVirgula = semSinal.lastIndexOf(',');

  let normalizado: string;
  if (ultimoPonto >= 0 && ultimaVirgula >= 0) {
    normalizado =
      ultimaVirgula > ultimoPonto
        ? semSinal.replace(/\./g, '').replace(',', '.')
        : semSinal.replace(/,/g, '');
  } else if (ultimaVirgula >= 0) {
    normalizado = semSinal.replace(',', '.');
  } else if (ultimoPonto >= 0) {
    const casas = semSinal.length - ultimoPonto - 1;
    if (casas === 3 && ultimoPonto > 0) {
      throw new Error(
        `Valor ambíguo: '${bruto}' pode ser milhar ou decimal. Use duas casas decimais.`,
      );
    }
    normalizado = semSinal;
  } else {
    normalizado = semSinal;
  }

  const [inteiro = '0', decimal = ''] = normalizado.split('.');
  if (decimal.length > 2) {
    throw new Error(`Valor com mais de duas casas decimais: '${bruto}'.`);
  }

  const centavos = Number(inteiro) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(centavos)) {
    throw new Error(`Valor fora da faixa representável: '${bruto}'.`);
  }

  return negativo ? -centavos : centavos;
}

/** Primeiro CNPJ de 14 dígitos no texto, se houver. */
function digitos(texto: string): string | undefined {
  const juntado = texto.replace(/(?<=\d)[\s.\-/]+(?=\d)/g, '');
  return /(?<!\d)(\d{14})(?!\d)/.exec(juntado)?.[1];
}

function normalizarColuna(bruto: string): string {
  return bruto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_');
}
