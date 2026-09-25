import { describe, it, expect } from 'vitest';
import { renderReadinessPdf } from '../../../src/fiscal/reporting/readiness-pdf.js';
import type { ReadinessReport } from '../../../src/fiscal/ingestion/readiness.js';
import { countPdfPages, extractPdfText } from '../../helpers/pdf.js';

const RELATORIO: ReadinessReport = {
  totals: { documents: 3, parsed: 2, rejected: 1, duplicates: 0 },
  documentsReady: { total: 2, ready: 1, readyPct: 50 },
  itemsReady: { total: 4, ready: 1, readyPct: 25 },
  valueReady: { totalCents: 200_000, readyCents: 150_000, readyPct: 75 },
  periods: [{ period: '2026-01', documents: { total: 2, ready: 1, readyPct: 50 } }],
  issuers: [
    { cnpj: '11222333000181', name: 'FORNECEDOR PRONTO LTDA', documents: { total: 1, ready: 1, readyPct: 100 }, totalCents: 150_000 },
  ],
  issuersTruncated: false,
  ncms: [],
  ncmsTruncated: false,
  rejections: [{ filename: 'quebrado.xml', layer: 1, reason: 'schema_violation', message: 'XML malformado.' }],
};

describe('renderReadinessPdf', () => {
  it('traz os números da tela, o fornecedor e o XML recusado', async () => {
    const pdf = await renderReadinessPdf(RELATORIO, new Date('2026-09-25T12:00:00Z'));
    const texto = extractPdfText(pdf);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(countPdfPages(pdf)).toBeGreaterThanOrEqual(1);
    expect(texto).toMatch(/1 de 2 \(50%\)/);
    expect(texto).toMatch(/75%/);
    expect(texto).toMatch(/FORNECEDOR PRONTO LTDA/);
    expect(texto).toMatch(/11\.222\.333\/0001-81/);
    expect(texto).toMatch(/quebrado\.xml/);
    expect(texto).toMatch(/não foram guardados/);
  });
});
