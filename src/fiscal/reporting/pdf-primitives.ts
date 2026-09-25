import type PDFDocument from 'pdfkit';

/**
 * Primitivos de layout dos PDFs do produto (Book de fechamento, relatório do
 * diagnóstico público). Saíram do `book-pdf.ts` para os dois documentos terem a
 * mesma cara, e para o Book não mudar ao ganhar um irmão.
 */

type Doc = InstanceType<typeof PDFDocument>;

/** Verde institucional do design system EJR, só em título e destaque. */
export const VERDE = '#365D5A';
export const CINZA = '#6B6660';
export const TEXTO = '#2D2A26';
export const VERMELHO = '#DC2424';
export const AMBAR = '#BD740F';

export const MARGEM = 48;

/**
 * Rodapé em todas as páginas, com o hash. Feito no fim porque só então se sabe
 * o total de páginas — e porque o hash precisa estar na folha isolada, não só
 * na capa.
 */
export function rodapes(doc: Doc, texto: string): number {
  const intervalo = doc.bufferedPageRange();

  for (let i = 0; i < intervalo.count; i++) {
    doc.switchToPage(intervalo.start + i);

    // O pdfkit descarta texto escrito abaixo da margem inferior, e o rodapé
    // fica de propósito na faixa reservada para ele. Zerar a margem da página
    // é o que libera essa faixa; nada de corpo é escrito depois daqui.
    doc.page.margins.bottom = 0;

    const y = doc.page.height - MARGEM - 6;
    doc.fontSize(7).font('Helvetica').fillColor(CINZA);

    doc.text(
      texto,
      MARGEM,
      y,
      { width: doc.page.width - MARGEM * 2, align: 'left', lineBreak: false },
    );

    doc.text(`${i + 1}/${intervalo.count}`, MARGEM, y, {
      width: doc.page.width - MARGEM * 2,
      align: 'right',
      lineBreak: false,
    });
  }

  return intervalo.count;
}

// ------------------------------------------------------------- primitivos

export function secao(doc: Doc, titulo: string, noTopo = false): void {
  if (!noTopo) {
    doc.moveDown(1);
  }
  doc.fillColor(VERDE).fontSize(13).font('Helvetica-Bold').text(titulo);
  doc.moveDown(0.4);
}

export function caixa(doc: Doc, titulo: string, corpo: string): void {
  doc.fontSize(9.5).font('Helvetica-Bold').fillColor(TEXTO).text(titulo);
  doc.fontSize(9).font('Helvetica').fillColor(CINZA).text(corpo, { align: 'justify' });
}

export function linhaDeDados(doc: Doc, pares: [string, string][]): void {
  for (const [rotulo, valor] of pares) {
    doc.fontSize(9).font('Helvetica').fillColor(CINZA).text(`${rotulo}: `, { continued: true });
    doc.font('Helvetica-Bold').fillColor(TEXTO).text(valor);
  }
}

export function cabecalhoDeTabela(
  doc: Doc,
  colunas: string[],
  larguras: number[],
): void {
  const y = doc.y;
  let x = MARGEM;

  doc.fontSize(8).font('Helvetica-Bold').fillColor(CINZA);
  colunas.forEach((titulo, i) => {
    doc.text(titulo, x, y, { width: larguras[i]!, align: i === 0 ? 'left' : 'right' });
    x += larguras[i]!;
  });

  doc.x = MARGEM;
  doc.moveDown(0.2);
  doc
    .moveTo(MARGEM, doc.y)
    .lineTo(MARGEM + larguras.reduce((a, b) => a + b, 0), doc.y)
    .strokeColor('#E2DFDB')
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.3);
}

export function linhaDeTabela(
  doc: Doc,
  celulas: string[],
  larguras: number[],
  cor = TEXTO,
  tamanho = 8.5,
): void {
  // Quebra de página manual: o rodapé reserva espaço, e escrever por cima dele
  // deixaria o hash ilegível justamente na página que precisa dele.
  if (doc.y > doc.page.height - MARGEM - 48) {
    doc.addPage();
  }

  const y = doc.y;
  let x = MARGEM;

  doc.fontSize(tamanho).font('Helvetica').fillColor(cor);
  celulas.forEach((valor, i) => {
    doc.text(valor, x, y, { width: larguras[i]!, align: i === 0 ? 'left' : 'right', lineBreak: false });
    x += larguras[i]!;
  });

  doc.x = MARGEM;
  doc.y = y + tamanho + 3.5;
}

export function formatarBRL(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatarCnpj(cnpj: string): string {
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}
