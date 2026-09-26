import {
  AMBAR,
  CINZA,
  MARGEM,
  TEXTO,
  VERMELHO,
  cabecalhoDeTabela,
  formatarBRL,
  linhaDeTabela,
  secao,
} from './pdf-primitives.js';

/**
 * A auditoria contínua no Book: o que foi examinado, o que não concluiu e o
 * que o contador decidiu sobre cada achado.
 *
 * A seção sai **sempre**, inclusive vazia. Omiti-la quando nenhuma trilha
 * rodou faria o Book de uma competência não auditada ter a mesma cara do Book
 * de uma competência auditada e limpa.
 */

export interface BookAuditExecution {
  procedureName: string;
  status: 'completed' | 'inconclusive';
  inconclusiveReason: string | null;
  populationSize: number;
  examinedCount: number;
  findingsCount: number;
  criterionVerified: boolean;
}

export interface BookAuditFinding {
  subject: string;
  procedureName: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  impactCents: number;
  status: 'open' | 'accepted' | 'rejected' | 'resolved';
  assertable: boolean;
  reviewNote: string | null;
}

export interface BookAuditSection {
  executions: readonly BookAuditExecution[];
  findings: readonly BookAuditFinding[];
}

/** Mais que isso não cabe num Book legível; o resto fica no painel. */
export const MAX_ACHADOS_NO_BOOK = 60;

type Doc = PDFKit.PDFDocument;

export function auditoriaContinua(doc: Doc, section: BookAuditSection): void {
  doc.addPage();
  secao(doc, 'Auditoria contínua', true);

  if (section.executions.length === 0) {
    doc
      .fontSize(9.5)
      .font('Helvetica')
      .fillColor(CINZA)
      .text(
        'Nenhuma trilha foi executada nesta competência. A ausência de achados aqui ' +
          'não significa que os créditos foram conferidos.',
      );
    return;
  }

  const semCriterio = section.executions.filter((e) => !e.criterionVerified).length;
  if (semCriterio > 0) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(AMBAR)
      .text(
        `${semCriterio} trilha(s) citam critério ainda não conferido em texto oficial. ` +
          'Os achados delas são apontamentos, não afirmações, e não autorizam estorno.',
      );
    doc.moveDown(0.5);
  }

  const larguras = [230, 70, 70, 60, 69];
  cabecalhoDeTabela(doc, ['Trilha', 'Situação', 'Examinados', 'Achados', 'Critério'], larguras);
  for (const e of section.executions) {
    linhaDeTabela(
      doc,
      [
        e.procedureName,
        e.status === 'completed' ? 'concluída' : 'inconclusiva',
        `${e.examinedCount} de ${e.populationSize}`,
        String(e.findingsCount),
        e.criterionVerified ? 'conferido' : 'não conferido',
      ],
      larguras,
      e.status === 'completed' ? TEXTO : AMBAR,
    );
  }

  const motivos = section.executions.filter((e) => e.inconclusiveReason !== null);
  if (motivos.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(TEXTO).text('Por que não concluíram');
    for (const e of motivos) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXTO).text(`${e.procedureName}: `, { continued: true });
      doc.font('Helvetica').fillColor(CINZA).text(e.inconclusiveReason!);
    }
  }

  achados(doc, section.findings);
}

function achados(doc: Doc, lista: readonly BookAuditFinding[]): void {
  doc.moveDown(0.8);
  doc.fontSize(10.5).font('Helvetica-Bold').fillColor(TEXTO).text('Achados');

  if (lista.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor(CINZA).text('Nenhum achado registrado.');
    return;
  }

  doc.moveDown(0.3);

  /**
   * Um bloco por achado, e não tabela: a chave de acesso tem 44 dígitos e não
   * cabe numa coluna. Cortá-la tiraria do Book justamente o que o destinatário
   * precisa para achar a nota.
   */
  for (const a of lista.slice(0, MAX_ACHADOS_NO_BOOK)) {
    if (doc.y > doc.page.height - MARGEM - 60) {
      doc.addPage();
    }

    const grave = a.severity === 'critical' || a.severity === 'high';
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(grave ? VERMELHO : TEXTO).text(a.subject, MARGEM);

    const detalhes = [
      a.procedureName,
      `severidade ${rotuloDeSeveridade(a.severity)}`,
      formatarBRL(a.impactCents),
      rotuloDeRevisao(a.status),
    ];
    if (!a.assertable) {
      detalhes.push('não afirma: critério não conferido');
    }
    doc.fontSize(8).font('Helvetica').fillColor(a.assertable ? CINZA : AMBAR).text(detalhes.join(' · '), MARGEM);
    doc.moveDown(0.25);
  }

  if (lista.length > MAX_ACHADOS_NO_BOOK) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(CINZA)
      .text(
        `… e outros ${lista.length - MAX_ACHADOS_NO_BOOK} achado(s). A lista completa está no painel.`,
        MARGEM,
      );
  }

  /** Recusa com motivo vai impressa: é o que a revisão exige. */
  const recusados = lista.filter((a) => a.status === 'rejected' && a.reviewNote !== null);
  if (recusados.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(TEXTO).text('Achados recusados pelo contador', MARGEM);
    for (const a of recusados.slice(0, MAX_ACHADOS_NO_BOOK)) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXTO).text(`${a.subject}: `, { continued: true });
      doc.font('Helvetica').fillColor(CINZA).text(a.reviewNote!);
    }
  }
}

function rotuloDeSeveridade(s: BookAuditFinding['severity']): string {
  return { critical: 'crítica', high: 'alta', medium: 'média', low: 'baixa' }[s];
}

function rotuloDeRevisao(s: BookAuditFinding['status']): string {
  return { open: 'aberto', accepted: 'aceito', rejected: 'recusado', resolved: 'resolvido' }[s];
}

/**
 * Monta a seção a partir da leitura da auditoria. Puro: o nome da trilha vem do
 * catálogo, e trilha desconhecida aparece pelo identificador em vez de sumir.
 */
export function montarSecaoDeAuditoria(
  executions: readonly {
    procedure_id: string;
    status: 'completed' | 'inconclusive';
    inconclusive_reason: string | null;
    population_size: number;
    examined_count: number;
    findings_count: number;
    criterion_verified: boolean;
  }[],
  findings: readonly {
    procedure_id: string;
    subject: string;
    severity: BookAuditFinding['severity'];
    impact_cents: number;
    status: BookAuditFinding['status'];
    assertable: boolean;
    review_note: string | null;
  }[],
  nomes: ReadonlyMap<string, string>,
): BookAuditSection {
  const nome = (id: string): string => nomes.get(id) ?? id;

  return {
    executions: executions.map((e) => ({
      procedureName: nome(e.procedure_id),
      status: e.status,
      inconclusiveReason: e.inconclusive_reason,
      populationSize: e.population_size,
      examinedCount: e.examined_count,
      findingsCount: e.findings_count,
      criterionVerified: e.criterion_verified,
    })),
    findings: findings.map((f) => ({
      subject: f.subject,
      procedureName: nome(f.procedure_id),
      severity: f.severity,
      impactCents: f.impact_cents,
      status: f.status,
      assertable: f.assertable,
      reviewNote: f.review_note,
    })),
  };
}
