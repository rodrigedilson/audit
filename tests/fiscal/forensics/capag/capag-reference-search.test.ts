import { describe, it, expect } from 'vitest';
import { extrairReferencias, type FetchBytes } from '../../../../src/fiscal/forensics/capag/capag-reference-search.js';
import type { CapagExtractorPort } from '../../../../src/fiscal/forensics/capag/capag-extractor.port.js';
import type { CapagExtraction } from '../../../../src/fiscal/forensics/capag/capag-extraction.js';
import { extracaoDoDemonstrativo } from '../../../helpers/capag.js';

const PAGINA_COM_FORMULA =
  '<html><body><p>A PGFN estima a capacidade de pagamento pela fórmula CAPAG-P = 5 x (0,10 x V1 + 0,40 x V7) + V8, ' +
  'em que V1 é a receita bruta, V7 a massa salarial e V8 o patrimônio líquido.</p></body></html>';

const fetchDe = (paginas: Record<string, string>): FetchBytes => async (url) => {
  const html = paginas[url];
  if (html === undefined) throw new Error('respondeu 404');
  return { bytes: new TextEncoder().encode(html), contentType: 'text/html' };
};

/** Extrator dublado: só a fórmula, como numa página de doutrina. */
const extratorDaFormula = (mudar?: (e: CapagExtraction) => void): CapagExtractorPort => ({
  name: 'dublê',
  async extract() {
    const e: CapagExtraction = {
      ...extracaoDoDemonstrativo(),
      documentKind: 'norma_ou_doutrina',
      values: [],
      capag: null,
      totalDebt: null,
      band: null,
      referenceDate: null,
    };
    mudar?.(e);
    return e;
  },
});

describe('extrairReferencias', () => {
  it('fórmula com os trechos na página: vira candidata, com as fontes', async () => {
    const r = await extrairReferencias(
      ['https://a.exemplo/capag', 'https://b.exemplo/capag'],
      extratorDaFormula(),
      fetchDe({ 'https://a.exemplo/capag': PAGINA_COM_FORMULA, 'https://b.exemplo/capag': PAGINA_COM_FORMULA }),
    );

    expect(r.discarded).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ group: 'pj_nao_simples', incomeMultiplier: 5 });
    expect(r.candidates[0]!.terms.map((t) => [t.variable, t.coefficient])).toEqual([
      ['V1', 0.1],
      ['V7', 0.4],
      ['V8', 1],
    ]);
    // Duas páginas com a mesma fórmula: uma candidata, duas fontes.
    expect(r.candidates[0]!.sources.map((s) => s.url)).toEqual(['https://a.exemplo/capag', 'https://b.exemplo/capag']);
  });

  it('coeficiente que não está na página baixada: fonte descartada', async () => {
    const r = await extrairReferencias(
      ['https://a.exemplo/capag'],
      extratorDaFormula((e) => {
        e.formula!.terms[0]!.coefficient = { printed: '0,30', quote: '0,30 x V1' };
      }),
      fetchDe({ 'https://a.exemplo/capag': PAGINA_COM_FORMULA }),
    );

    expect(r.candidates).toEqual([]);
    expect(r.discarded[0]!.reason).toMatch(/trecho não confere/);
  });

  it('página que não abre, ou que não traz fórmula, é descartada com o motivo', async () => {
    const r = await extrairReferencias(
      ['https://fora.exemplo', 'https://a.exemplo/capag'],
      extratorDaFormula((e) => {
        e.formula = null;
      }),
      fetchDe({ 'https://a.exemplo/capag': PAGINA_COM_FORMULA }),
    );

    expect(r.discarded.map((d) => d.reason)).toEqual([
      expect.stringMatching(/não foi possível ler/),
      'a página não traz a fórmula',
    ]);
  });
});
