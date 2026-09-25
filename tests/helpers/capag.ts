import PDFDocument from 'pdfkit';
import type { CapagExtraction } from '../../src/fiscal/forensics/capag/capag-extraction.js';

/**
 * Demonstrativo de exemplo, com a conta fechando:
 * 5 × (0,10 × R$ 1.000.000,00 + 0,40 × R$ 200.000,00) + R$ 50.000,00 = R$ 950.000,00.
 * Os números são do teste, não da PGFN.
 */
export const DEMONSTRATIVO_LINHAS = [
  'Demonstrativo de Capacidade de Pagamento Presumida',
  'Contribuinte: pessoa jurídica não optante pelo Simples Nacional',
  'Data de referência: 01/08/2026',
  'Fórmula: CAPAG-P = 5 x (0,10 x V1 + 0,40 x V7) + V8',
  'V1 - Receita bruta declarada: R$ 1.000.000,00',
  'V7 - Massa salarial: R$ 200.000,00',
  'V8 - Patrimônio líquido: R$ 50.000,00',
  'Dívida total consolidada: R$ 2.000.000,00',
  'Capacidade de pagamento presumida: R$ 950.000,00',
  'Classificação: C',
];

export const DEMONSTRATIVO_TEXTO = DEMONSTRATIVO_LINHAS.join('\n');

export function extracaoDoDemonstrativo(): CapagExtraction {
  return {
    documentKind: 'demonstrativo_regularize',
    group: 'pj_nao_simples',
    referenceDate: { printed: '01/08/2026', quote: 'Data de referência: 01/08/2026' },
    legalBasis: 'Portaria PGFN 6.757/2022',
    formula: {
      incomeMultiplier: { printed: '5', quote: 'CAPAG-P = 5 x (0,10 x V1' },
      terms: [
        {
          variable: 'V1',
          description: 'Receita bruta declarada',
          coefficient: { printed: '0,10', quote: '0,10 x V1' },
          block: 'multiplied',
          substitutes: null,
          source: 'ECF',
        },
        {
          variable: 'V7',
          description: 'Massa salarial',
          coefficient: { printed: '0,40', quote: '0,40 x V7' },
          block: 'multiplied',
          substitutes: null,
          source: 'eSocial',
        },
        {
          variable: 'V8',
          description: 'Patrimônio líquido',
          // Implícito: "+ V8", sem número impresso.
          coefficient: { printed: '', quote: '+ V8' },
          block: 'added',
          substitutes: null,
          source: 'ECF',
        },
      ],
    },
    values: [
      { variable: 'V1', amount: { printed: 'R$ 1.000.000,00', quote: 'V1 - Receita bruta declarada: R$ 1.000.000,00' } },
      { variable: 'V7', amount: { printed: 'R$ 200.000,00', quote: 'V7 - Massa salarial: R$ 200.000,00' } },
      { variable: 'V8', amount: { printed: 'R$ 50.000,00', quote: 'V8 - Patrimônio líquido: R$ 50.000,00' } },
    ],
    capag: { printed: 'R$ 950.000,00', quote: 'Capacidade de pagamento presumida: R$ 950.000,00' },
    totalDebt: { printed: 'R$ 2.000.000,00', quote: 'Dívida total consolidada: R$ 2.000.000,00' },
    band: { value: 'C', quote: 'Classificação: C' },
  };
}

export async function pdfDoDemonstrativo(linhas: readonly string[] = DEMONSTRATIVO_LINHAS): Promise<Buffer> {
  const doc = new PDFDocument();
  const partes: Buffer[] = [];
  doc.on('data', (p: Buffer) => partes.push(p));
  const fim = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(partes))));
  for (const l of linhas) doc.text(l);
  doc.end();
  return fim;
}
