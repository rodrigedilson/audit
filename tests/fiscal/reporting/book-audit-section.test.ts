import { describe, expect, it } from 'vitest';

import { renderBook, type BookInput } from '../../../src/fiscal/reporting/book-pdf.js';
import {
  MAX_ACHADOS_NO_BOOK,
  montarSecaoDeAuditoria,
  type BookAuditSection,
} from '../../../src/fiscal/reporting/book-audit-section.js';
import { extractPdfText } from '../../helpers/pdf.js';

const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function entrada(audit?: BookAuditSection): BookInput {
  return {
    tenantName: 'Escritório',
    cnpj: '12345678000195',
    legalName: 'CLIENTE LTDA',
    regime: 'lucro_presumido',
    period: '2027-03',
    audience: 'accountant',
    whiteLabel: false,
    includeTrace: false,
    projectionHash: HASH,
    periodState: 'assessed',
    generatedAt: new Date('2027-04-05T12:00:00Z'),
    trails: [],
    summary: { passed: 0, warning: 0, failed: 0, not_applicable: 0, amountAtStakeCents: 0 },
    totals: {},
    totalDueCents: 0,
    documentsCount: 1,
    itemsCount: 1,
    coverage: { itemsWithReformGroup: 1, itemsTotal: 1 },
    notComputable: [],
    trace: [],
    ...(audit === undefined ? {} : { audit }),
  };
}

const execucao = {
  procedureName: 'Crédito sem documento hábil',
  status: 'inconclusive' as const,
  inconclusiveReason: "O critério 'lc-214-credito-documento-habil' não foi conferido em texto oficial.",
  populationSize: 3,
  examinedCount: 3,
  findingsCount: 1,
  criterionVerified: false,
};

const achado = {
  subject: '35270811222333000181550010000000151234567890',
  procedureName: 'Crédito sem documento hábil',
  severity: 'high' as const,
  impactCents: 250_000,
  status: 'open' as const,
  assertable: false,
  reviewNote: null,
};

describe('Book — seção de auditoria contínua', () => {
  it('sem execução, a seção sai e diz que nada foi conferido', async () => {
    const texto = extractPdfText((await renderBook(entrada({ executions: [], findings: [] }))).pdf);

    expect(texto).toContain('Auditoria contínua');
    expect(texto).toContain('Nenhuma trilha foi executada nesta competência');
  });

  it('inconclusão e critério não conferido aparecem por extenso', async () => {
    const texto = extractPdfText(
      (await renderBook(entrada({ executions: [execucao], findings: [achado] }))).pdf,
    );

    expect(texto).toContain('inconclusiva');
    expect(texto).toContain('não conferido');
    expect(texto).toContain('não foi conferido em texto oficial');
    expect(texto).toContain('apontamentos, não afirmações');
  });

  it('achado que não afirma leva a ressalva ao lado do sujeito', async () => {
    const texto = extractPdfText(
      (await renderBook(entrada({ executions: [execucao], findings: [achado] }))).pdf,
    );

    // A chave inteira, nunca cortada: é por ela que o destinatário acha a nota.
    expect(texto).toContain(achado.subject);
    expect(texto).toContain('não afirma: critério não conferido');
    expect(texto).toContain('R$ 2.500,00');
  });

  it('a recusa do contador vai impressa com o motivo', async () => {
    const recusado = { ...achado, status: 'rejected' as const, reviewNote: 'Chave conferida no portal.' };

    const texto = extractPdfText(
      (await renderBook(entrada({ executions: [execucao], findings: [recusado] }))).pdf,
    );

    expect(texto).toContain('Achados recusados pelo contador');
    expect(texto).toContain('Chave conferida no portal.');
  });

  it('muitos achados são cortados e o Book diz quantos ficaram de fora', async () => {
    const muitos = Array.from({ length: MAX_ACHADOS_NO_BOOK + 3 }, (_, i) => ({
      ...achado,
      subject: `SUJEITO-${i}`,
    }));

    const texto = extractPdfText(
      (await renderBook(entrada({ executions: [execucao], findings: muitos }))).pdf,
    );

    expect(texto).toContain('e outros 3 achado(s)');
  });

  it('sem a seção no input, o Book não a inventa', async () => {
    const texto = extractPdfText((await renderBook(entrada())).pdf);

    expect(texto).not.toContain('Auditoria contínua');
  });
});

describe('montarSecaoDeAuditoria', () => {
  it('troca o identificador pelo nome, e trilha desconhecida aparece pelo id', () => {
    const secao = montarSecaoDeAuditoria(
      [
        {
          procedure_id: 'credito-extemporaneo',
          status: 'completed',
          inconclusive_reason: null,
          population_size: 2,
          examined_count: 2,
          findings_count: 0,
          criterion_verified: true,
        },
      ],
      [
        {
          procedure_id: 'trilha-que-saiu-do-catalogo',
          subject: 'X',
          severity: 'low',
          impact_cents: 0,
          status: 'resolved',
          assertable: true,
          review_note: null,
        },
      ],
      new Map([['credito-extemporaneo', 'Crédito extemporâneo']]),
    );

    expect(secao.executions[0]!.procedureName).toBe('Crédito extemporâneo');
    expect(secao.findings[0]!.procedureName).toBe('trilha-que-saiu-do-catalogo');
  });
});
