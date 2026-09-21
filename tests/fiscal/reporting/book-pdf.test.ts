import { describe, it, expect } from 'vitest';
import { renderBook, type BookInput, type BookTraceLine } from '../../../src/fiscal/reporting/book-pdf.js';
import { extractPdfText, countPdfPages } from '../../helpers/pdf.js';
import type { TrailResult, TrailStatus } from '../../../src/fiscal/reporting/audit-trails.js';

const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function trilha(
  trailId: string,
  name: string,
  status: TrailStatus,
  issues: TrailResult['issues'] = [],
  amountAtStakeCents = 0,
): TrailResult {
  return {
    trailId,
    name,
    description: `Descrição de ${name}, com acentuação e ç.`,
    layer: 3,
    severity: 'critical',
    taxScope: 'reform',
    status,
    issuesCount: issues.length,
    amountAtStakeCents,
    documentsAffected: issues.length,
    issues,
  };
}

function linha(i: number): BookTraceLine {
  return {
    accessKey: `3527091234567800019555001000000${String(i).padStart(4, '0')}1234`,
    line: 1,
    tax: i % 2 === 0 ? 'cbs' : 'icms',
    itemCode: `SKU-${i}`,
    direction: i % 3 === 0 ? 'inbound' : 'outbound',
    baseCents: 100_000 + i,
    rate: 18,
    amountCents: 18_000 + i,
  };
}

function entrada(override: Partial<BookInput> = {}): BookInput {
  return {
    tenantName: 'Escritório Contábil Ação & Cia',
    cnpj: '12345678000195',
    legalName: 'INDÚSTRIA DE PRODUÇÃO LTDA',
    regime: 'lucro_real',
    period: '2027-09',
    audience: 'accountant',
    whiteLabel: false,
    includeTrace: true,
    projectionHash: HASH,
    periodState: 'confirmed',
    generatedAt: new Date('2027-10-05T12:00:00Z'),
    trails: [
      trilha(
        'cclasstrib_vs_cst',
        'cClassTrib incompatível com CST-IBS/CBS',
        'failed',
        [
          {
            subject: 'SKU-1',
            message: 'Combinação inválida: CST 000 com cClassTrib 200001.',
            severity: 'critical',
            documentsAffected: 12,
            amountAtStakeCents: 4_500_000,
          },
        ],
        4_500_000,
      ),
      trilha('codigo_nao_verificado', 'Código não verificado', 'not_applicable'),
      trilha('documento_duplicado', 'Documento recebido em duplicidade', 'passed'),
    ],
    summary: { passed: 1, warning: 0, failed: 1, not_applicable: 1, amountAtStakeCents: 4_500_000 },
    totals: {
      icms: {
        debitsCents: 1_800_000,
        potentialCreditsCents: 320_000,
        creditableCents: 320_000,
        dueCents: 1_480_000,
      },
      cbs: {
        debitsCents: 921_000,
        potentialCreditsCents: 0,
        creditableCents: null,
        dueCents: null,
      },
    },
    totalDueCents: null,
    documentsCount: 137,
    itemsCount: 412,
    coverage: { itemsWithReformGroup: 300, itemsTotal: 412 },
    notComputable: [
      { subject: 'cbs', message: 'Regra de creditamento de CBS não publicada para a competência.' },
    ],
    trace: Array.from({ length: 12 }, (_, i) => linha(i)),
    ...override,
  };
}

describe('Book de fechamento — PDF', () => {
  it('produz um PDF válido com mais de uma página', async () => {
    const r = await renderBook(entrada());

    expect(r.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(r.pages).toBeGreaterThan(1);
    expect(countPdfPages(r.pdf)).toBe(r.pages);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * A razão de ser do documento. O rodapé chegou a não ser desenhado por
   * escrever abaixo da margem inferior, e nenhuma asserção sobre bytes,
   * páginas ou SHA-256 percebeu: uma folha encaminhada isolada ficava sem
   * nada para conferir.
   */
  it('imprime o hash da projeção no rodapé de TODAS as páginas', async () => {
    const r = await renderBook(entrada());
    const texto = extractPdfText(r.pdf);

    const ocorrencias = texto.split(HASH).length - 1;
    expect(ocorrencias).toBe(r.pages);
  });

  it('numera as páginas com o total, para detectar folha faltando', async () => {
    const r = await renderBook(entrada());
    const texto = extractPdfText(r.pdf);

    for (let i = 1; i <= r.pages; i++) {
      expect(texto).toContain(`${i}/${r.pages}`);
    }
  });

  it('preserva acentuação e cedilha no texto do documento', async () => {
    const texto = extractPdfText((await renderBook(entrada())).pdf);

    expect(texto).toContain('Competência 2027-09');
    expect(texto).toContain('INDÚSTRIA DE PRODUÇÃO LTDA');
    expect(texto).toContain('Apuração dual');
  });

  it('formata o CNPJ e o regime em rótulo legível', async () => {
    const texto = extractPdfText((await renderBook(entrada())).pdf);

    expect(texto).toContain('12.345.678/0001-95');
    expect(texto).toContain('Lucro Real');
    expect(texto).toContain('Confirmada e fechada');
  });

  /**
   * Um valor devido ausente não pode aparecer como zero: zero é uma afirmação
   * fiscal, e "não determinável" é a verdade quando falta regra publicada.
   */
  it('escreve "não determinável" onde o devido é null, nunca zero', async () => {
    const texto = extractPdfText((await renderBook(entrada())).pdf);

    expect(texto).toContain('não determinável');
    expect(texto).toContain('Total devido: não determinável nesta competência');
    expect(texto).toContain('Regra de creditamento de CBS não publicada');
  });

  it('avisa que trilha não verificada não é trilha aprovada', async () => {
    const texto = extractPdfText((await renderBook(entrada())).pdf);

    expect(texto).toContain('NÃO VERIF.');
    expect(texto).toMatch(/não significa que a classificação está correta/);
  });

  it('mostra o valor em risco somado quando há trilha reprovada', async () => {
    const texto = extractPdfText((await renderBook(entrada())).pdf);

    expect(texto).toContain('Valor em risco identificado: R$ 45.000,00');
  });

  it('omite a marca do produto no modo white label', async () => {
    const comMarca = extractPdfText((await renderBook(entrada())).pdf);
    const semMarca = extractPdfText((await renderBook(entrada({ whiteLabel: true })).then((r) => r)).pdf);

    expect(comMarca).toContain('audit');
    expect(semMarca).not.toContain('conciliação da transição tributária');
    expect(semMarca).toContain('Escritório Contábil Ação & Cia');
  });

  it('troca o texto explicativo conforme o destinatário', async () => {
    const contador = extractPdfText((await renderBook(entrada())).pdf);
    const dono = extractPdfText(
      (await renderBook(entrada({ audience: 'business_owner' }))).pdf,
    );

    expect(contador).toContain('replay determinístico');
    expect(dono).toContain('O que é este documento');
    expect(dono).not.toContain('replay determinístico');
  });

  it('sem memória de cálculo, o anexo não é impresso', async () => {
    const com = await renderBook(entrada());
    const sem = await renderBook(entrada({ includeTrace: false }));

    expect(extractPdfText(com.pdf)).toContain('Memória de cálculo');
    expect(extractPdfText(sem.pdf)).not.toContain('Memória de cálculo');
    expect(sem.pages).toBeLessThan(com.pages);
  });

  /**
   * Um CNPJ com milhares de linhas geraria um Book que ninguém lê. O corte é
   * declarado no próprio documento, e não silencioso.
   */
  it('corta a memória de cálculo declarando o total real', async () => {
    const r = await renderBook(
      entrada({ trace: Array.from({ length: 450 }, (_, i) => linha(i)) }),
    );

    const texto = extractPdfText(r.pdf);
    expect(texto).toContain('Exibindo 400 de 450 linhas');
  });

  it('o SHA-256 é do arquivo, e muda quando o conteúdo muda', async () => {
    const a = await renderBook(entrada());
    const b = await renderBook(entrada({ documentsCount: 138 }));

    expect(a.sha256).not.toBe(b.sha256);
  });

  it('sem tributo com movimento, diz que não houve, em vez de tabela vazia', async () => {
    const texto = extractPdfText(
      (
        await renderBook(
          entrada({
            totals: {
              icms: {
                debitsCents: 0,
                potentialCreditsCents: 0,
                creditableCents: 0,
                dueCents: 0,
              },
            },
          }),
        )
      ).pdf,
    );

    expect(texto).toContain('Nenhum tributo destacado na competência');
  });

  it('a seção de ocorrências some quando nenhuma trilha tem inconsistência', async () => {
    const texto = extractPdfText(
      (
        await renderBook(
          entrada({
            trails: [trilha('documento_duplicado', 'Documento em duplicidade', 'passed')],
            summary: {
              passed: 1,
              warning: 0,
              failed: 0,
              not_applicable: 0,
              amountAtStakeCents: 0,
            },
          }),
        )
      ).pdf,
    );

    expect(texto).not.toContain('Detalhe das ocorrências');
  });
});
