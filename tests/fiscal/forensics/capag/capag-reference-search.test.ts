import { describe, it, expect } from 'vitest';
import { extrairReferencias, tipoDaFonte, URL_OFICIAL_PGFN, type FetchBytes } from '../../../../src/fiscal/forensics/capag/capag-reference-search.js';
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

/** Trecho da página oficial, com os coeficientes com ponto, como a PGFN imprime. */
const PAGINA_OFICIAL =
  '<html><body><p>Pessoa física: Capag-p = 5(0.3V1 + 0.1V2 + V3) + 0.8V4</p>' +
  '<p>Pessoa jurídica optante pelo Simples: Capag-p = 5(0.03V1 + 0.09V2) + 0.70V7</p></body></html>';

const t = (variable: string, printed: string, quote: string, block: 'multiplied' | 'added' = 'multiplied') => ({
  variable,
  description: variable,
  coefficient: { printed, quote },
  block,
  substitutes: null,
  source: '',
});

/** Extrator dublado da página oficial: duas fórmulas, uma por grupo. */
const extratorDaPaginaOficial = (): CapagExtractorPort => ({
  name: 'dublê',
  async extract() {
    return {
      ...extracaoDoDemonstrativo(),
      documentKind: 'norma_ou_doutrina',
      group: null,
      formula: null,
      formulas: [
        {
          group: 'pessoa_fisica',
          incomeMultiplier: { printed: '5', quote: 'Capag-p = 5(0.3V1' },
          terms: [
            t('V1', '0.3', '5(0.3V1'),
            t('V2', '0.1', '0.1V2'),
            t('V3', '', '+ V3)'),
            t('V4', '0.8', '0.8V4', 'added'),
          ],
        },
        {
          group: 'pj_simples',
          incomeMultiplier: { printed: '5', quote: 'Capag-p = 5(0.03V1' },
          terms: [t('V1', '0.03', '5(0.03V1'), t('V2', '0.09', '0.09V2'), t('V7', '0.70', '0.70V7', 'added')],
        },
      ],
      values: [],
      capag: null,
      totalDebt: null,
      band: null,
      referenceDate: null,
    } satisfies CapagExtraction;
  },
});

describe('fonte oficial da PGFN', () => {
  it('só a página da PGFN no gov.br, em https, é oficial', () => {
    expect(tipoDaFonte(URL_OFICIAL_PGFN)).toBe('oficial_pgfn');
    expect(tipoDaFonte('http://www.gov.br/pgfn/pt-br/x')).toBe('doutrina');
    expect(tipoDaFonte('https://www.gov.br/receitafederal/pt-br/x')).toBe('doutrina');
    expect(tipoDaFonte('https://www.gov.br.exemplo.com/pgfn/x')).toBe('doutrina');
    expect(tipoDaFonte('não é url')).toBe('doutrina');
  });

  it('página oficial com várias fórmulas: uma candidata conferida por grupo, antes da doutrina', async () => {
    const paginas = { [URL_OFICIAL_PGFN]: PAGINA_OFICIAL, 'https://a.exemplo/capag': PAGINA_COM_FORMULA };
    const extratores: Record<string, CapagExtractorPort> = {
      [URL_OFICIAL_PGFN]: extratorDaPaginaOficial(),
      'https://a.exemplo/capag': extratorDaFormula(),
    };
    let atual = '';
    const extractor: CapagExtractorPort = { name: 'dublê', extract: (e) => extratores[atual]!.extract(e) };
    const buscar: FetchBytes = async (url) => {
      atual = url;
      return fetchDe(paginas)(url);
    };

    const r = await extrairReferencias(['https://a.exemplo/capag', URL_OFICIAL_PGFN], extractor, buscar);

    expect(r.discarded).toEqual([]);
    expect(r.candidates.map((c) => [c.group, c.sourceKind, c.verified])).toEqual([
      ['pessoa_fisica', 'oficial_pgfn', true],
      ['pj_simples', 'oficial_pgfn', true],
      ['pj_nao_simples', 'doutrina', false],
    ]);
    expect(r.candidates[0]!.terms.map((x) => [x.variable, x.coefficient, x.block])).toEqual([
      ['V1', 0.3, 'multiplied'],
      ['V2', 0.1, 'multiplied'],
      ['V3', 1, 'multiplied'],
      ['V4', 0.8, 'added'],
    ]);
  });

  it('um grupo da página oficial com trecho que não confere é descartado, e os outros ficam', async () => {
    const base = extratorDaPaginaOficial();
    const extractor: CapagExtractorPort = {
      name: 'dublê',
      async extract(e) {
        const x = await base.extract(e);
        x.formulas[1]!.terms[0]!.coefficient = { printed: '0.05', quote: '5(0.05V1' };
        return x;
      },
    };

    const r = await extrairReferencias([URL_OFICIAL_PGFN], extractor, fetchDe({ [URL_OFICIAL_PGFN]: PAGINA_OFICIAL }));

    expect(r.candidates.map((c) => c.group)).toEqual(['pessoa_fisica']);
    expect(r.discarded[0]!.reason).toMatch(/trecho não confere \(grupo pj_simples\)/);
  });
});
