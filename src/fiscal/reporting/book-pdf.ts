import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { TrailResult, TrailsSummary } from './audit-trails.js';
import {
  AMBAR,
  CINZA,
  MARGEM,
  TEXTO,
  VERDE,
  VERMELHO,
  cabecalhoDeTabela,
  caixa,
  formatarBRL,
  formatarCnpj,
  linhaDeDados,
  linhaDeTabela,
  rodapes,
  secao,
} from './pdf-primitives.js';

export { formatarBRL } from './pdf-primitives.js';

/**
 * Renderiza o Book de fechamento em PDF.
 *
 * O documento é feito para sair do escritório e chegar ao cliente final, e é por
 * isso que o **hash da projeção vai no rodapé de todas as páginas**: qualquer
 * folha isolada continua verificável. Um hash só na capa se perde quando alguém
 * encaminha duas páginas.
 */

export type Audience = 'accountant' | 'business_owner';

export interface BookTaxTotals {
  debitsCents: number;
  potentialCreditsCents: number;
  creditableCents: number | null;
  dueCents: number | null;
}

export interface BookTraceLine {
  accessKey: string;
  line: number;
  tax: string;
  itemCode: string;
  direction: string;
  baseCents: number;
  rate: number;
  amountCents: number;
}

export interface BookInput {
  tenantName: string;
  cnpj: string;
  legalName: string;
  regime: string;
  period: string;
  audience: Audience;
  whiteLabel: boolean;
  includeTrace: boolean;
  projectionHash: string;
  periodState: string;
  generatedAt: Date;
  trails: readonly TrailResult[];
  summary: TrailsSummary;
  totals: Record<string, BookTaxTotals>;
  totalDueCents: number | null;
  documentsCount: number;
  itemsCount: number;
  coverage: { itemsWithReformGroup: number; itemsTotal: number };
  notComputable: readonly { subject: string; message: string }[];
  trace: readonly BookTraceLine[];
}

export interface RenderedBook {
  pdf: Buffer;
  pages: number;
  sha256: string;
}

/** Linhas da memória de cálculo por Book: acima disso ninguém lê o anexo. */
export const MAX_LINHAS_TRACE = 400;

export async function renderBook(input: BookInput): Promise<RenderedBook> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEM, bottom: MARGEM + 24, left: MARGEM, right: MARGEM },
    // Necessário para numerar e assinar o rodapé depois de saber o total.
    bufferPages: true,
    info: {
      Title: `Book de fechamento ${input.cnpj} ${input.period}`,
      Author: input.whiteLabel ? input.tenantName : 'audit',
      Subject: `Competência ${input.period}`,
      Keywords: input.projectionHash,
    },
  });

  const pedacos: Buffer[] = [];
  doc.on('data', (pedaco: Buffer) => pedacos.push(pedaco));

  const finalizado = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
  });

  capa(doc, input);
  resumoDasTrilhas(doc, input);
  apuracao(doc, input);
  detalheDasTrilhas(doc, input);

  if (input.includeTrace && input.trace.length > 0) {
    memoriaDeCalculo(doc, input);
  }

  const paginas = rodapes(doc, `${formatarCnpj(input.cnpj)} · ${input.period} · hash ${input.projectionHash}`);
  doc.end();

  const pdf = await finalizado;

  return {
    pdf,
    pages: paginas,
    // SHA-256 do próprio arquivo: detecta troca do PDF por quem tenha escrita
    // na tabela, o que o hash da projeção não cobre.
    sha256: createHash('sha256').update(pdf).digest('hex'),
  };
}

function capa(doc: PDFKit.PDFDocument, input: BookInput): void {
  if (!input.whiteLabel) {
    doc.fillColor(CINZA).fontSize(9).font('Helvetica').text('audit · conciliação da transição tributária');
    doc.moveDown(0.3);
  }

  doc.fillColor(VERDE).fontSize(22).font('Helvetica-Bold').text('Book de fechamento');
  doc.moveDown(0.2);
  doc
    .fillColor(TEXTO)
    .fontSize(13)
    .font('Helvetica')
    .text(`Competência ${input.period}`);
  doc.moveDown(1);

  linhaDeDados(doc, [
    ['Cliente', `${input.legalName} · ${formatarCnpj(input.cnpj)}`],
    ['Regime', rotuloDeRegime(input.regime)],
    ['Escritório', input.tenantName],
    ['Estado da competência', rotuloDeEstado(input.periodState)],
    ['Documentos considerados', String(input.documentsCount)],
    ['Itens considerados', String(input.itemsCount)],
    ['Gerado em', input.generatedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })],
  ]);

  doc.moveDown(0.8);

  if (input.audience === 'business_owner') {
    caixa(
      doc,
      'O que é este documento',
      'Este relatório mostra o que os documentos fiscais da sua empresa dizem, no sistema ' +
        'tributário atual e no que entra em vigor com a reforma, lado a lado. O código no ' +
        'rodapé de cada página identifica esta versão exata: se qualquer número mudar, o ' +
        'código muda também.',
    );
  } else {
    caixa(
      doc,
      'Sobre a verificação',
      'Os valores abaixo derivam exclusivamente dos documentos fiscais ingeridos na ' +
        'competência. O hash no rodapé é o SHA-256 da projeção do event log e permite ' +
        'reproduzir este fechamento por replay determinístico (INV-006).',
    );
  }
}

function resumoDasTrilhas(doc: PDFKit.PDFDocument, input: BookInput): void {
  secao(doc, 'Trilhas de auditoria');

  const { summary } = input;
  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor(TEXTO)
    .text(
      `${summary.failed} reprovada(s) · ${summary.warning} com aviso · ` +
        `${summary.passed} aprovada(s) · ${summary.not_applicable} não verificada(s)`,
    );

  if (summary.amountAtStakeCents > 0) {
    doc.moveDown(0.3);
    doc
      .fillColor(VERMELHO)
      .font('Helvetica-Bold')
      .text(`Valor em risco identificado: ${formatarBRL(summary.amountAtStakeCents)}`);
  }

  if (summary.not_applicable > 0) {
    doc.moveDown(0.3);
    doc
      .fillColor(AMBAR)
      .font('Helvetica')
      .fontSize(9)
      .text(
        `Atenção: ${summary.not_applicable} trilha(s) não pôde(puderam) ser verificada(s) por ` +
          'falta das tabelas oficiais de códigos. A ausência de erro nessas trilhas não ' +
          'significa que a classificação está correta.',
      );
  }

  doc.moveDown(0.6);

  const LARGURA_STATUS = 64;

  for (const trilha of input.trails) {
    const cor =
      trilha.status === 'failed' ? VERMELHO : trilha.status === 'warning' ? AMBAR : CINZA;

    const complemento: string[] = [];
    if (trilha.issuesCount > 0) complemento.push(`${trilha.issuesCount} ocorrência(s)`);
    if (trilha.documentsAffected > 0) complemento.push(`${trilha.documentsAffected} nota(s)`);
    if (trilha.amountAtStakeCents > 0) complemento.push(formatarBRL(trilha.amountAtStakeCents));

    // Duas colunas em posição absoluta, e não `continued: true`: a chamada
    // encadeada mantinha o cursor em modo continuado e a trilha seguinte era
    // escrita sobre a anterior.
    const y = doc.y;
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(cor);
    doc.text(rotuloDeStatus(trilha.status), MARGEM, y, {
      width: LARGURA_STATUS,
      lineBreak: false,
    });

    const texto =
      complemento.length > 0 ? `${trilha.name} — ${complemento.join(' · ')}` : trilha.name;

    doc.fontSize(9).font('Helvetica').fillColor(TEXTO);
    doc.text(texto, MARGEM + LARGURA_STATUS, y, {
      width: doc.page.width - MARGEM * 2 - LARGURA_STATUS,
    });

    doc.x = MARGEM;
  }
}

function apuracao(doc: PDFKit.PDFDocument, input: BookInput): void {
  secao(doc, 'Apuração dual');

  const tributos = Object.entries(input.totals).filter(
    ([, t]) => t.debitsCents !== 0 || t.potentialCreditsCents !== 0,
  );

  if (tributos.length === 0) {
    doc.fontSize(10).font('Helvetica').fillColor(CINZA).text('Nenhum tributo destacado na competência.');
    return;
  }

  const colunas = [150, 90, 90, 90, 90];
  cabecalhoDeTabela(doc, ['Tributo', 'Débito', 'Crédito pot.', 'Aproveitável', 'Devido'], colunas);

  for (const [tributo, total] of tributos) {
    linhaDeTabela(
      doc,
      [
        rotuloDeTributo(tributo),
        formatarBRL(total.debitsCents),
        formatarBRL(total.potentialCreditsCents),
        total.creditableCents === null ? '—' : formatarBRL(total.creditableCents),
        total.dueCents === null ? 'não determinável' : formatarBRL(total.dueCents),
      ],
      colunas,
      total.dueCents === null ? AMBAR : TEXTO,
    );
  }

  doc.moveDown(0.5);
  doc
    .fontSize(10.5)
    .font('Helvetica-Bold')
    .fillColor(input.totalDueCents === null ? AMBAR : VERDE)
    .text(
      input.totalDueCents === null
        ? 'Total devido: não determinável nesta competência'
        : `Total devido: ${formatarBRL(input.totalDueCents)}`,
    );

  if (input.notComputable.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(TEXTO).text('Por que há valores não determináveis');
    doc.font('Helvetica').fillColor(CINZA);
    for (const motivo of input.notComputable.slice(0, 12)) {
      doc.fontSize(8.5).text(`• ${motivo.message}`, { indent: 8 });
    }
  }

  const { itemsWithReformGroup, itemsTotal } = input.coverage;
  if (itemsTotal > 0) {
    doc.moveDown(0.5);
    const pct = Math.round((itemsWithReformGroup / itemsTotal) * 100);
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(TEXTO)
      .text(
        `Prontidão para a reforma: ${itemsWithReformGroup} de ${itemsTotal} itens (${pct}%) ` +
          'já vêm com o grupo IBS/CBS no documento.',
      );
  }
}

function detalheDasTrilhas(doc: PDFKit.PDFDocument, input: BookInput): void {
  const comOcorrencia = input.trails.filter((t) => t.issuesCount > 0);
  if (comOcorrencia.length === 0) {
    return;
  }

  doc.addPage();
  secao(doc, 'Detalhe das ocorrências', true);

  for (const trilha of comOcorrencia) {
    doc.moveDown(0.5);
    doc
      .fontSize(10.5)
      .font('Helvetica-Bold')
      .fillColor(trilha.status === 'failed' ? VERMELHO : AMBAR)
      .text(trilha.name);

    doc.fontSize(8.5).font('Helvetica').fillColor(CINZA).text(trilha.description);

    if (trilha.layer !== null) {
      doc.fontSize(8).fillColor(CINZA).text(`Detectada na camada ${trilha.layer} do pipeline.`);
    }

    doc.moveDown(0.25);
    doc.fontSize(8.5).fillColor(TEXTO);

    for (const ocorrencia of trilha.issues) {
      doc.font('Helvetica-Bold').text(`${ocorrencia.subject}  `, { continued: true });
      doc.font('Helvetica').text(ocorrencia.message);
    }

    if (trilha.issuesCount > trilha.issues.length) {
      doc
        .font('Helvetica-Oblique')
        .fillColor(CINZA)
        .fontSize(8)
        .text(
          `… e outras ${trilha.issuesCount - trilha.issues.length} ocorrência(s). ` +
            'A lista completa está no painel.',
        );
    }
  }
}

function memoriaDeCalculo(doc: PDFKit.PDFDocument, input: BookInput): void {
  doc.addPage();
  secao(doc, 'Memória de cálculo', true);

  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor(CINZA)
    .text(
      'Uma linha por item e por tributo, com o valor como destacado no documento. ' +
        'É a origem de cada número da apuração acima.',
    );
  doc.moveDown(0.5);

  const colunas = [138, 26, 52, 58, 62, 40, 62];
  cabecalhoDeTabela(
    doc,
    ['Chave de acesso', 'It', 'Tributo', 'Base', 'Alíquota', 'E/S', 'Valor'],
    colunas,
  );

  for (const linha of input.trace.slice(0, MAX_LINHAS_TRACE)) {
    linhaDeTabela(
      doc,
      [
        `…${linha.accessKey.slice(-16)}`,
        String(linha.line),
        rotuloDeTributo(linha.tax),
        formatarBRL(linha.baseCents),
        `${linha.rate.toFixed(2)}%`,
        linha.direction === 'outbound' ? 'S' : 'E',
        formatarBRL(linha.amountCents),
      ],
      colunas,
      TEXTO,
      7.5,
    );
  }

  if (input.trace.length > MAX_LINHAS_TRACE) {
    doc.moveDown(0.4);
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor(CINZA)
      .text(
        `Exibindo ${MAX_LINHAS_TRACE} de ${input.trace.length} linhas. ` +
          'A memória completa está disponível no painel e por exportação.',
      );
  }
}


// ---------------------------------------------------------------- rótulos



function rotuloDeStatus(status: TrailResult['status']): string {
  const mapa: Record<TrailResult['status'], string> = {
    failed: 'REPROVADA',
    warning: 'AVISO',
    passed: 'OK',
    not_applicable: 'NÃO VERIF.',
  };
  return mapa[status];
}

function rotuloDeTributo(tributo: string): string {
  const mapa: Record<string, string> = {
    icms: 'ICMS',
    ipi: 'IPI',
    pis: 'PIS',
    cofins: 'COFINS',
    ibs_uf: 'IBS-UF',
    ibs_mun: 'IBS-Mun',
    cbs: 'CBS',
  };
  return mapa[tributo] ?? tributo.toUpperCase();
}

function rotuloDeRegime(regime: string): string {
  const mapa: Record<string, string> = {
    mei: 'MEI',
    simples_integrado: 'Simples Nacional integrado',
    simples_hibrido: 'Simples Nacional híbrido',
    lucro_presumido: 'Lucro Presumido',
    lucro_real: 'Lucro Real',
  };
  return mapa[regime] ?? regime;
}

function rotuloDeEstado(estado: string): string {
  const mapa: Record<string, string> = {
    open: 'Aberta',
    assessed: 'Apurada',
    reconciled: 'Conciliada',
    confirmed: 'Confirmada e fechada',
  };
  return mapa[estado] ?? estado;
}
