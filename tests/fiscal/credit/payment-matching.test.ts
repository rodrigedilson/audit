import { describe, it, expect } from 'vitest';
import {
  matchPayments,
  JANELA_PADRAO_DIAS,
  type PayableDocument,
} from '../../../src/fiscal/credit/payment-matching.js';
import type { StatementLine } from '../../../src/fiscal/credit/statement-parser.js';

const CHAVE_A = '35270912345678000195550010000000011234567893';
const CHAVE_B = '35270912345678000195550010000000021234567890';

function documento(override: Partial<PayableDocument> = {}): PayableDocument {
  return {
    accessKey: CHAVE_A,
    number: '000001234',
    supplierCnpj: '98765432000199',
    supplierName: 'FORNECEDOR LTDA',
    issuedAt: '2027-11-10T10:00:00Z',
    totalCents: 100_000,
    ...override,
  };
}

function lancamento(override: Partial<StatementLine> = {}): StatementLine {
  return {
    fitid: 'L1',
    postedAt: '2027-11-25',
    amountCents: -100_000,
    description: 'PAGAMENTO FORNECEDOR',
    ...override,
  };
}

const casar = (docs: PayableDocument[], linhas: StatementLine[], windowDays?: number) =>
  matchPayments({
    documents: docs,
    lines: linhas,
    ...(windowDays === undefined ? {} : { windowDays }),
  });

describe('casamento pagamento × documento', () => {
  it('valor idêntico dentro da janela casa como hipótese forte', () => {
    const r = casar([documento()], [lancamento()]);

    expect(r).toHaveLength(1);
    expect(r[0]!.confidence).toBe('amount_and_date');
    expect(r[0]!.accessKey).toBe(CHAVE_A);
    expect(r[0]!.rationale).toContain('dentro de');
  });

  it('valor idêntico fora da janela casa como hipótese fraca', () => {
    const r = casar([documento()], [lancamento({ postedAt: '2028-06-01' })]);

    expect(r[0]!.confidence).toBe('amount_only');
    expect(r[0]!.rationale).toMatch(/fora da janela/);
  });

  it('a janela é parâmetro, porque é heurística e não norma', () => {
    const tarde = lancamento({ postedAt: '2027-12-20' });

    expect(casar([documento()], [tarde], 10)[0]!.confidence).toBe('amount_only');
    expect(casar([documento()], [tarde], 60)[0]!.confidence).toBe('amount_and_date');
    expect(JANELA_PADRAO_DIAS).toBe(90);
  });

  it('valor diferente não casa', () => {
    expect(casar([documento()], [lancamento({ amountCents: -99_999 })])).toHaveLength(0);
  });

  /** Considerar entrada de caixa casaria um recebimento com uma nota de compra. */
  it('entrada de caixa é ignorada', () => {
    expect(casar([documento()], [lancamento({ amountCents: 100_000 })])).toHaveLength(0);
  });

  describe('identificação explícita vence a heurística', () => {
    it('chave de acesso no histórico casa como exact', () => {
      const r = casar([documento()], [lancamento({ description: `PIX ref ${CHAVE_A}` })]);

      expect(r[0]!.confidence).toBe('exact');
    });

    it('a máscara no histórico não impede a identificação pela chave', () => {
      const mascarada = CHAVE_A.replace(/(.{4})/g, '$1 ').trim();
      const r = casar([documento()], [lancamento({ description: `TED ${mascarada}` })]);

      expect(r[0]!.confidence).toBe('exact');
    });

    it('número da nota no histórico casa como exact', () => {
      const r = casar([documento()], [lancamento({ description: 'PAGTO NF 000001234' })]);

      expect(r[0]!.confidence).toBe('exact');
    });

    /**
     * Identificação explícita vale mesmo com valor diferente: é o caso do
     * pagamento parcial ou com desconto, e a heurística de valor nunca deve
     * sobrepor quem já disse de qual nota se trata.
     */
    it('identificada no histórico casa mesmo com valor divergente', () => {
      const r = casar(
        [documento()],
        [lancamento({ amountCents: -95_000, description: `pagto ${CHAVE_A}` })],
      );

      expect(r).toHaveLength(1);
      expect(r[0]!.confidence).toBe('exact');
    });

    /**
     * "NF 15" casaria com qualquer histórico que contenha "15" — inclusive uma
     * data ou um valor. Um `exact` errado é pior do que nenhum casamento.
     */
    it('número curto não serve como identificação', () => {
      const r = casar(
        [documento({ number: '15', totalCents: 12_345 })],
        [lancamento({ amountCents: -777, description: 'TARIFA 15/11' })],
      );

      expect(r).toHaveLength(0);
    });

    it('documento sem número não quebra a busca por identificação', () => {
      const r = casar([documento({ number: null })], [lancamento()]);

      expect(r[0]!.confidence).toBe('amount_and_date');
    });
  });

  describe('ambiguidade não é resolvida no palpite', () => {
    /**
     * Dois documentos do mesmo valor no mesmo período são indistinguíveis por
     * valor e data. Escolher um no critério de "o primeiro que apareceu"
     * produziria uma afirmação sem base — e liberaria crédito da nota errada.
     */
    it('dois candidatos de igual valor devolvem ambiguous com os candidatos', () => {
      const r = casar([documento(), documento({ accessKey: CHAVE_B })], [lancamento()]);

      expect(r).toHaveLength(1);
      expect(r[0]!.confidence).toBe('ambiguous');
      expect(r[0]!.candidates).toEqual([CHAVE_A, CHAVE_B]);
      expect(r[0]!.rationale).toMatch(/escolher um seria afirmar sem base/);
    });

    it('a janela desempata quando só um candidato está dentro dela', () => {
      const r = casar(
        [documento(), documento({ accessKey: CHAVE_B, issuedAt: '2026-01-10T10:00:00Z' })],
        [lancamento()],
      );

      expect(r[0]!.confidence).toBe('amount_and_date');
      expect(r[0]!.accessKey).toBe(CHAVE_A);
    });

    it('a identificação no histórico desempata o que o valor não desempata', () => {
      const r = casar(
        [documento(), documento({ accessKey: CHAVE_B, number: '000009999' })],
        [lancamento({ description: 'PAGTO NF 000009999' })],
      );

      expect(r[0]!.confidence).toBe('exact');
      expect(r[0]!.accessKey).toBe(CHAVE_B);
    });

    /** O ambíguo não consome o documento: ele continua candidato. */
    it('documento em casamento ambíguo segue disponível para outro lançamento', () => {
      const r = casar(
        [documento(), documento({ accessKey: CHAVE_B })],
        [lancamento(), lancamento({ fitid: 'L2', description: `ref ${CHAVE_A}` })],
      );

      expect(r[0]!.confidence).toBe('ambiguous');
      expect(r[1]!.confidence).toBe('exact');
      expect(r[1]!.accessKey).toBe(CHAVE_A);
    });
  });

  /**
   * Sem isso, um único pagamento liberaria o crédito de várias notas de igual
   * valor — multiplicando o crédito aproveitado por um pagamento que aconteceu
   * uma vez só.
   */
  it('um lançamento paga uma nota: o documento casado sai da disputa', () => {
    const r = casar(
      [documento(), documento({ accessKey: CHAVE_B, issuedAt: '2026-01-10T10:00:00Z' })],
      [lancamento(), lancamento({ fitid: 'L2' })],
    );

    expect(r).toHaveLength(2);
    expect(new Set(r.map((m) => m.accessKey)).size).toBe(2);
  });

  it('pagamento no mesmo dia da emissão está dentro da janela', () => {
    const r = casar([documento()], [lancamento({ postedAt: '2027-11-10' })]);

    expect(r[0]!.confidence).toBe('amount_and_date');
  });

  /** Adiantamento existe; o dia a menos cobre o fuso do carimbo de emissão. */
  it('pagamento um dia antes da emissão ainda é atribuível', () => {
    const r = casar([documento()], [lancamento({ postedAt: '2027-11-09' })]);

    expect(r[0]!.confidence).toBe('amount_and_date');
  });

  it('pagamento muito antes da emissão cai para hipótese fraca', () => {
    const r = casar([documento()], [lancamento({ postedAt: '2027-01-01' })]);

    expect(r[0]!.confidence).toBe('amount_only');
  });

  it('data de emissão ilegível não entra na janela por acidente', () => {
    const r = casar([documento({ issuedAt: 'inválida' })], [lancamento()]);

    expect(r[0]!.confidence).toBe('amount_only');
  });

  it('extrato sem lançamento nenhum não produz casamento', () => {
    expect(casar([documento()], [])).toHaveLength(0);
  });

  it('lançamento sem documento candidato não produz casamento', () => {
    expect(casar([], [lancamento()])).toHaveLength(0);
  });
});
