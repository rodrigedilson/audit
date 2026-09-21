import { inflateSync } from 'node:zlib';

/**
 * Extrai o texto de um PDF descomprimindo os content streams.
 *
 * Existe porque o rodapé com o hash da projeção — a razão de ser do Book —
 * chegou a não ser desenhado, e nenhuma asserção sobre bytes, páginas ou
 * SHA-256 percebeu: o PDF era válido e o conteúdo, ausente. Sem ler o texto de
 * volta, o teste só prova que um arquivo foi gerado.
 */
export function extractPdfText(pdf: Buffer): string {
  // O espaço inseparável (U+00A0) que o `Intl` pt-BR põe entre `R$` e o valor
  // é normalizado: visualmente é um espaço, e sem isto toda asserção sobre
  // moeda precisaria carregar o caractere invisível no literal do teste.
  return contentStreams(pdf).flatMap(showText).join('\n').replace(/\u00a0/g, ' ');
}

/** Quantas páginas o PDF declara, lido do próprio arquivo e não do gerador. */
export function countPdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function contentStreams(pdf: Buffer): string[] {
  const saida: string[] = [];
  const bruto = pdf.toString('latin1');
  const marcador = /stream\r?\n/g;

  let achado: RegExpExecArray | null;
  while ((achado = marcador.exec(bruto)) !== null) {
    const inicio = achado.index + achado[0].length;
    const fim = bruto.indexOf('endstream', inicio);
    if (fim === -1) {
      continue;
    }

    try {
      saida.push(inflateSync(Buffer.from(bruto.slice(inicio, fim), 'latin1')).toString('latin1'));
    } catch {
      // Stream que não é deflate (fonte embutida, por exemplo) não interessa.
      continue;
    }
  }

  return saida;
}

/**
 * Operandos de `TJ` e `Tj`.
 *
 * O pdfkit escreve `[<hex> kern <hex> …] TJ` com as fontes padrão: strings
 * hexadecimais em WinAnsi, intercaladas com deslocamentos de kerning. Os
 * números são espaçamento, não texto, e são descartados; os pedaços de string
 * do mesmo array formam uma linha.
 */
function showText(stream: string): string[] {
  const linhas: string[] = [];
  const operador = /\[((?:<[0-9a-fA-F]*>|\((?:\\.|[^\\()])*\)|[-\d.\s])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9a-fA-F]*)>\s*Tj/g;

  let achado: RegExpExecArray | null;
  while ((achado = operador.exec(stream)) !== null) {
    if (achado[1] !== undefined) {
      linhas.push(pedacosDoArray(achado[1]));
    } else if (achado[2] !== undefined) {
      linhas.push(deWinAnsi(desescapar(achado[2])));
    } else if (achado[3] !== undefined) {
      linhas.push(deWinAnsi(deHex(achado[3])));
    }
  }

  return linhas;
}

function pedacosDoArray(corpo: string): string {
  const pedaco = /<([0-9a-fA-F]*)>|\(((?:\\.|[^\\()])*)\)/g;
  let texto = '';

  let achado: RegExpExecArray | null;
  while ((achado = pedaco.exec(corpo)) !== null) {
    texto += achado[1] !== undefined ? deHex(achado[1]) : desescapar(achado[2]!);
  }

  return deWinAnsi(texto);
}

function deHex(hex: string): string {
  const par = hex.length % 2 === 0 ? hex : `${hex}0`;
  return Buffer.from(par, 'hex').toString('latin1');
}

/** Desfaz o escape de string literal do PDF. */
function desescapar(bruto: string): string {
  const bytes: number[] = [];

  for (let i = 0; i < bruto.length; i++) {
    const c = bruto[i]!;
    if (c !== '\\') {
      bytes.push(c.charCodeAt(0));
      continue;
    }

    const octal = /^[0-7]{1,3}/.exec(bruto.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }

    i += 1;
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    bytes.push(escapes[bruto[i] ?? ''] ?? (bruto[i] ?? '').charCodeAt(0));
  }

  return Buffer.from(bytes).toString('latin1');
}

/**
 * WinAnsi difere do latin1 justamente na faixa 0x80–0x9F, onde ficam a
 * travessão, as reticências e o bullet — que o Book usa. Sem este mapa, o
 * teste veria caracteres de controle no lugar deles.
 */
const WINANSI_ALTO: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function deWinAnsi(latin1: string): string {
  let saida = '';
  for (const caractere of latin1) {
    const codigo = caractere.charCodeAt(0);
    saida += codigo >= 0x80 && codigo <= 0x9f ? (WINANSI_ALTO[codigo] ?? caractere) : caractere;
  }
  return saida;
}
