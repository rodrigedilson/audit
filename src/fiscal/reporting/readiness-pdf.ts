import PDFDocument from 'pdfkit';
import type { ReadinessReport } from '../ingestion/readiness.js';
import {
  CINZA,
  MARGEM,
  TEXTO,
  VERDE,
  cabecalhoDeTabela,
  caixa,
  formatarBRL,
  formatarCnpj,
  linhaDeDados,
  linhaDeTabela,
  rodapes,
  secao,
} from './pdf-primitives.js';

/**
 * Relatório do diagnóstico público de prontidão, em PDF, para o visitante que
 * pediu o envio por e-mail. É o mesmo retrato da tela, com os mesmos números:
 * nada é recalculado aqui.
 */

const MAX_LINHAS = 30;

export async function renderReadinessPdf(report: ReadinessReport, generatedAt: Date): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEM, bottom: MARGEM + 24, left: MARGEM, right: MARGEM },
    bufferPages: true,
    info: { Title: 'Diagnóstico de prontidão para a reforma tributária', Author: 'audit' },
  });

  const pedacos: Buffer[] = [];
  doc.on('data', (p: Buffer) => pedacos.push(p));
  const finalizado = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
  });

  doc.fillColor(VERDE).fontSize(18).font('Helvetica-Bold').text('Diagnóstico de prontidão para a reforma');
  doc.moveDown(0.3);
  doc
    .fillColor(CINZA)
    .fontSize(9.5)
    .font('Helvetica')
    .text(
      'Quantos dos seus fornecedores já emitem NF-e com o grupo de IBS/CBS (NT 2025.002), a partir ' +
        'dos XMLs que você enviou. Os documentos não foram guardados.',
    );
  doc.moveDown(0.6);
  linhaDeDados(doc, [
    ['Gerado em', generatedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })],
    ['XMLs enviados', String(report.totals.documents)],
    ['Lidos', String(report.totals.parsed)],
    ['Recusados', String(report.totals.rejected)],
  ]);

  secao(doc, 'Prontidão');
  linhaDeDados(doc, [
    ['Documentos com IBS/CBS', `${report.documentsReady.ready} de ${report.documentsReady.total} (${report.documentsReady.readyPct}%)`],
    ['Itens com IBS/CBS', `${report.itemsReady.ready} de ${report.itemsReady.total} (${report.itemsReady.readyPct}%)`],
    [
      'Valor com IBS/CBS',
      `${formatarBRL(report.valueReady.readyCents)} de ${formatarBRL(report.valueReady.totalCents)} (${report.valueReady.readyPct}%)`,
    ],
  ]);

  if (report.periods.length > 0) {
    secao(doc, 'Por competência');
    const larguras = [200, 100, 100, 99];
    cabecalhoDeTabela(doc, ['Competência', 'Documentos', 'Prontos', '%'], larguras);
    for (const p of report.periods.slice(0, MAX_LINHAS)) {
      linhaDeTabela(doc, [p.period, String(p.documents.total), String(p.documents.ready), `${p.documents.readyPct}%`], larguras);
    }
  }

  if (report.issuers.length > 0) {
    secao(doc, 'Fornecedores');
    const larguras = [230, 90, 70, 109];
    cabecalhoDeTabela(doc, ['Fornecedor', 'Documentos', 'Prontos', 'Valor'], larguras);
    for (const e of report.issuers.slice(0, MAX_LINHAS)) {
      linhaDeTabela(
        doc,
        [`${e.name.slice(0, 38)} · ${formatarCnpj(e.cnpj)}`, String(e.documents.total), String(e.documents.ready), formatarBRL(e.totalCents)],
        larguras,
      );
    }
    if (report.issuers.length > MAX_LINHAS || report.issuersTruncated) {
      doc.moveDown(0.3).fontSize(8).fillColor(CINZA).text('Lista recortada nos fornecedores de maior valor.');
    }
  }

  if (report.rejections.length > 0) {
    secao(doc, 'XMLs que não puderam ser lidos');
    for (const r of report.rejections.slice(0, MAX_LINHAS)) {
      caixa(doc, r.filename, r.message);
    }
  }

  doc.moveDown(1).fontSize(8).font('Helvetica').fillColor(TEXTO);
  doc.text(
    'Este relatório é um retrato dos arquivos enviados, e não uma apuração. Ele não avalia a ' +
      'correção dos valores de IBS/CBS, só a presença do grupo na nota.',
  );

  rodapes(doc, 'Diagnóstico de prontidão · audit');
  doc.end();
  return finalizado;
}
