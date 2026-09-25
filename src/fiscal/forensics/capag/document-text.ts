import { textoDoHtml } from '../../catalog/monophasic-flags.js';

/**
 * Texto de um documento enviado para extração (demonstrativo de CAPAG, norma,
 * página de doutrina).
 *
 * O texto é a régua: o extrator só pode citar trecho que esteja aqui, e a
 * conferência compara contra este mesmo texto. Por isso ele sai daqui uma vez,
 * e é o mesmo que vai ao modelo.
 */

export type DocumentKind = 'pdf' | 'html' | 'text';

export class DocumentTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTextError';
  }
}

export interface DocumentText {
  kind: DocumentKind;
  text: string;
  pages: number | null;
}

/** Abaixo disto o PDF é digitalizado (imagem): não há texto para citar. */
const MINIMO_DE_CARACTERES = 40;

export function detectKind(bytes: Uint8Array, contentType: string | null): DocumentKind {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (contentType?.includes('pdf')) return 'pdf';
  const inicio = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).toLowerCase();
  if (contentType?.includes('html') || /<(!doctype html|html|body|table|div)\b/.test(inicio)) return 'html';
  return 'text';
}

async function textoDoPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  // Build legacy: a que roda no Node sem DOM. Importada sob demanda, porque
  // pesa, e só este caminho precisa dela.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const tarefa = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
  });
  const documento = await tarefa.promise;
  const paginas: string[] = [];
  for (let n = 1; n <= documento.numPages; n += 1) {
    const pagina = await documento.getPage(n);
    const conteudo = await pagina.getTextContent();
    const linhas: string[] = [];
    for (const item of conteudo.items) {
      if (!('str' in item)) continue;
      linhas.push(item.str);
      if (item.hasEOL) linhas.push('\n');
      else linhas.push(' ');
    }
    paginas.push(linhas.join('').replace(/[ \t]+\n/g, '\n'));
  }
  await tarefa.destroy();
  return { text: paginas.join('\n\n'), pages: documento.numPages };
}

/**
 * Extrai o texto. PDF digitalizado é recusado com motivo: sem texto não há
 * trecho para conferir, e ler a imagem seria confiar no modelo sem régua.
 */
export async function extractDocumentText(bytes: Uint8Array, contentType: string | null): Promise<DocumentText> {
  const kind = detectKind(bytes, contentType);
  let text: string;
  let pages: number | null = null;

  if (kind === 'pdf') {
    try {
      ({ text, pages } = await textoDoPdf(bytes));
    } catch (erro) {
      throw new DocumentTextError(
        `O PDF não pôde ser lido: ${erro instanceof Error ? erro.message : String(erro)}.`,
      );
    }
  } else {
    const bruto = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    text = kind === 'html' ? textoDoHtml(bruto) : bruto;
  }

  if (text.replace(/\s+/g, '').length < MINIMO_DE_CARACTERES) {
    throw new DocumentTextError(
      kind === 'pdf'
        ? 'O PDF não tem texto: parece digitalizado. Baixe o demonstrativo do REGULARIZE como PDF original, ou salve a página como HTML.'
        : 'O documento não tem texto suficiente para extrair a CAPAG.',
    );
  }
  return { kind, text, pages };
}
