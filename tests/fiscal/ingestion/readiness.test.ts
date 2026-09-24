import { describe, it, expect } from 'vitest';
import { summarizeReadiness } from '../../../src/fiscal/ingestion/readiness.js';
import { nfeXml } from '../../helpers/nfe-xml.js';

const EMITENTE_A = '11222333000181';
const EMITENTE_B = '11444777000161';
const DESTINATARIO = '99999999000191';

/** Açúcar: transforma XMLs em lote de upload. */
function lote(...conteudos: { nome: string; xml: string }[]) {
  return conteudos.map((c) => ({ filename: c.nome, content: c.xml }));
}

function nota(opcoes: Parameters<typeof nfeXml>[0] & { nome?: string }) {
  return { nome: opcoes.nome ?? `${opcoes.numero ?? '000000015'}.xml`, xml: nfeXml(opcoes) };
}

describe('summarizeReadiness — prontidão da carteira', () => {
  it('lote inteiro sem grupo UB dá 0%, e não NaN', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002' }),
      ),
    );

    expect(relatorio.documentsReady).toEqual({ total: 2, ready: 0, readyPct: 0 });
    expect(relatorio.totals.parsed).toBe(2);
  });

  it('lote inteiro com grupo UB dá 100%', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', withReform: true }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002', withReform: true }),
      ),
    );

    expect(relatorio.documentsReady.readyPct).toBe(100);
  });

  it('um em quatro dá 25%', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', withReform: true }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000003' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000004' }),
      ),
    );

    expect(relatorio.documentsReady.readyPct).toBe(25);
  });

  /**
   * Documento "pronto" pode ter item não pronto: o parser marca `hasReformGroup`
   * quando PELO MENOS UM item traz o grupo. Os dois recortes têm de divergir.
   */
  it('prontidão por item difere da prontidão por documento', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({
          issuer: EMITENTE_A,
          recipient: DESTINATARIO,
          numero: '000000001',
          items: [{ withReform: true }, { withReform: false }],
        }),
      ),
    );

    expect(relatorio.documentsReady.readyPct).toBe(100);
    expect(relatorio.itemsReady).toEqual({ total: 2, ready: 1, readyPct: 50 });
  });

  /**
   * O achado que mostra o tamanho do problema: poucos documentos podem
   * concentrar quase todo o dinheiro.
   */
  it('prontidão por valor diverge quando a nota pronta é a mais cara', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({
          issuer: EMITENTE_A,
          recipient: DESTINATARIO,
          numero: '000000001',
          withReform: true,
          items: [{ valor: 9000, withReform: true }],
        }),
        nota({
          issuer: EMITENTE_A,
          recipient: DESTINATARIO,
          numero: '000000002',
          items: [{ valor: 500 }],
        }),
        nota({
          issuer: EMITENTE_A,
          recipient: DESTINATARIO,
          numero: '000000003',
          items: [{ valor: 500 }],
        }),
      ),
    );

    expect(relatorio.documentsReady.readyPct).toBe(33.3);
    expect(relatorio.valueReady.readyPct).toBe(90);
  });

  it('XML malformado no meio do lote não derruba os outros', () => {
    const relatorio = summarizeReadiness([
      { filename: 'boa-1.xml', content: nfeXml({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001' }) },
      { filename: 'lixo.xml', content: '<xml>isto nao e uma nota' },
      { filename: 'boa-2.xml', content: nfeXml({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002' }) },
    ]);

    expect(relatorio.totals.parsed).toBe(2);
    expect(relatorio.totals.rejected).toBe(1);
    expect(relatorio.rejections[0]).toMatchObject({ filename: 'lixo.xml' });
  });

  it('arquivo vazio, só espaços ou binário é rejeitado sem lançar', () => {
    const relatorio = summarizeReadiness([
      { filename: 'vazio.xml', content: '' },
      { filename: 'espacos.xml', content: '   \n  ' },
      { filename: 'binario.xml', content: '\u0000\u0001\u0002PK\u0003\u0004' },
    ]);

    expect(relatorio.totals.rejected).toBe(3);
    expect(relatorio.totals.parsed).toBe(0);
    expect(relatorio.documentsReady.readyPct).toBe(0);
    expect(relatorio.valueReady.readyPct).toBe(0);
  });

  it('o mesmo XML duas vezes não infla o denominador', () => {
    const xml = nfeXml({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', withReform: true });
    const relatorio = summarizeReadiness([
      { filename: 'a.xml', content: xml },
      { filename: 'copia.xml', content: xml },
    ]);

    expect(relatorio.totals.documents).toBe(2);
    expect(relatorio.totals.parsed).toBe(1);
    expect(relatorio.totals.duplicates).toBe(1);
    expect(relatorio.documentsReady.total).toBe(1);
  });

  it('duas grafias de razão social viram um emitente, com o nome mais frequente', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', issuerName: 'ACME LTDA' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002', issuerName: 'ACME LTDA' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000003', issuerName: 'ACME  LTDA.' }),
      ),
    );

    expect(relatorio.issuers).toHaveLength(1);
    expect(relatorio.issuers[0]).toMatchObject({ cnpj: EMITENTE_A, name: 'ACME LTDA' });
    expect(relatorio.issuers[0]!.documents.total).toBe(3);
  });

  it('agrupa por emitente e ordena por volume de documentos', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002' }),
        nota({ issuer: EMITENTE_B, recipient: DESTINATARIO, numero: '000000003', withReform: true }),
      ),
    );

    expect(relatorio.issuers.map((e) => e.cnpj)).toEqual([EMITENTE_A, EMITENTE_B]);
    expect(relatorio.issuers[1]!.documents.readyPct).toBe(100);
  });

  it('item sem NCM aparece como achado, não desaparece', () => {
    const relatorio = summarizeReadiness(
      lote(nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', items: [{ ncm: '' }] })),
    );

    expect(relatorio.ncms.map((n) => n.ncm)).toContain('(sem NCM)');
  });

  it('trunca emitentes sem alterar os números globais', () => {
    const notas = Array.from({ length: 60 }, (_, i) =>
      nota({
        issuer: `1122233300${String(i).padStart(4, '0')}`,
        recipient: DESTINATARIO,
        numero: String(i + 1).padStart(9, '0'),
        withReform: i % 2 === 0,
      }),
    );

    const relatorio = summarizeReadiness(lote(...notas), { topN: 50 });

    expect(relatorio.issuers).toHaveLength(50);
    expect(relatorio.issuersTruncated).toBe(true);
    // O agregado é calculado sobre tudo, antes do corte.
    expect(relatorio.documentsReady.total).toBe(60);
    expect(relatorio.documentsReady.ready).toBe(30);
  });

  it('competências saem em ordem cronológica', () => {
    const relatorio = summarizeReadiness(
      lote(
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', issuedAt: '2027-09-10T10:00:00-03:00' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000002', issuedAt: '2027-07-10T10:00:00-03:00' }),
        nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000003', issuedAt: '2027-08-10T10:00:00-03:00' }),
      ),
    );

    expect(relatorio.periods.map((p) => p.period)).toEqual(['2027-07', '2027-08', '2027-09']);
  });

  it('a mesma entrada em ordem trocada dá o mesmo relatório', () => {
    const a = nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', withReform: true });
    const b = nota({ issuer: EMITENTE_B, recipient: DESTINATARIO, numero: '000000002' });

    expect(summarizeReadiness(lote(a, b))).toEqual(summarizeReadiness(lote(b, a)));
  });

  /**
   * A promessa do produto é que nada do documento é guardado nem devolvido além
   * do agregado. A chave de acesso é o identificador do documento — se ela
   * vazasse para o relatório, a rota pública viraria extrator de NF-e.
   */
  it('o relatório não carrega chave de acesso alguma', () => {
    const relatorio = summarizeReadiness(
      lote(nota({ issuer: EMITENTE_A, recipient: DESTINATARIO, numero: '000000001', withReform: true })),
    );

    expect(JSON.stringify(relatorio)).not.toMatch(/[0-9]{44}/);
  });

  it('lote vazio não divide por zero', () => {
    const relatorio = summarizeReadiness([]);

    expect(relatorio.totals).toEqual({ documents: 0, parsed: 0, rejected: 0, duplicates: 0 });
    expect(relatorio.documentsReady.readyPct).toBe(0);
    expect(relatorio.issuers).toEqual([]);
  });
});
