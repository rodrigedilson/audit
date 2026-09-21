import { describe, it, expect } from 'vitest';
import {
  parseStatement,
  StatementFormatError,
  MAX_LANCAMENTOS,
} from '../../../src/fiscal/credit/statement-parser.js';

function ofx(...transacoes: string[]): string {
  return `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>12345-6</ACCTID></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20271101<DTEND>20271130
${transacoes.join('\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

const trn = (campos: string): string => `<STMTTRN>${campos}</STMTTRN>`;

describe('extrato bancário — leitura', () => {
  describe('OFX', () => {
    it('lê o lançamento com data, valor em centavos e histórico', () => {
      const r = parseStatement(
        ofx(
          trn(
            '<TRNTYPE>DEBIT<DTPOSTED>20271125120000[-3:BRT]<TRNAMT>-1000.00' +
              '<FITID>202711250001<NAME>FORNECEDOR LTDA<MEMO>PAGTO NF 1234',
          ),
        ),
      );

      expect(r.source).toBe('ofx');
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatchObject({
        fitid: '202711250001',
        postedAt: '2027-11-25',
        amountCents: -100_000,
      });
      expect(r.lines[0]!.description).toContain('FORNECEDOR LTDA');
      expect(r.lines[0]!.description).toContain('PAGTO NF 1234');
    });

    it('lê conta e período do cabeçalho', () => {
      const r = parseStatement(
        ofx(trn('<DTPOSTED>20271125<TRNAMT>-10.00<FITID>A1<MEMO>x')),
      );

      expect(r.account).toBe('12345-6');
      expect(r.periodFrom).toBe('2027-11-01');
      expect(r.periodTo).toBe('2027-11-30');
    });

    /**
     * O OFX é SGML: tag sem fechamento é a regra, e um parser de XML recusaria
     * metade dos arquivos que os bancos emitem de verdade.
     */
    it('aceita tags sem fechamento, como os bancos emitem', () => {
      const r = parseStatement(ofx(trn('<DTPOSTED>20271125<TRNAMT>-50.25<FITID>B2<MEMO>TED')));

      expect(r.lines[0]!.amountCents).toBe(-5_025);
    });

    /**
     * Sem FITID a reimportação dobraria o lançamento, e um crédito apareceria
     * liberado por um pagamento que aconteceu uma vez só.
     */
    it('recusa o lançamento sem FITID, dizendo por quê', () => {
      const r = parseStatement(ofx(trn('<DTPOSTED>20271125<TRNAMT>-10.00<MEMO>x')));

      expect(r.lines).toHaveLength(0);
      expect(r.rejected[0]!.reason).toMatch(/duplicidade/);
    });

    it('um lançamento ruim não derruba os bons', () => {
      const r = parseStatement(
        ofx(
          trn('<DTPOSTED>20271125<TRNAMT>-10.00<FITID>A<MEMO>ok'),
          trn('<TRNAMT>-20.00<FITID>B<MEMO>sem data'),
          trn('<DTPOSTED>20271126<TRNAMT>-30.00<FITID>C<MEMO>ok'),
        ),
      );

      expect(r.lines).toHaveLength(2);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0]!.reason).toMatch(/DTPOSTED/);
    });

    it('extrai o CNPJ da contraparte do histórico quando ele está lá', () => {
      const r = parseStatement(
        ofx(trn('<DTPOSTED>20271125<TRNAMT>-10.00<FITID>A<MEMO>PIX 98.765.432/0001-99')),
      );

      expect(r.lines[0]!.counterpartyDoc).toBe('98765432000199');
    });

    it('arquivo OFX só com saldo é recusado, apontando a causa provável', () => {
      expect(() => parseStatement('<OFX><LEDGERBAL><BALAMT>100.00</LEDGERBAL></OFX>')).toThrow(
        /apenas com o saldo/,
      );
    });

    it('recusa o arquivo acima do limite de lançamentos', () => {
      const muitos = Array.from({ length: MAX_LANCAMENTOS + 1 }, (_, i) =>
        trn(`<DTPOSTED>20271125<TRNAMT>-1.00<FITID>F${i}<MEMO>x`),
      );

      expect(() => parseStatement(ofx(...muitos))).toThrow(/limite é/);
    });
  });

  describe('CSV', () => {
    const cabecalho = 'data;valor;historico';

    it('lê a data brasileira e o valor com vírgula decimal', () => {
      const r = parseStatement(`${cabecalho}\n25/11/2027;-1.000,00;PAGTO FORNECEDOR`);

      expect(r.source).toBe('csv');
      expect(r.lines[0]).toMatchObject({
        postedAt: '2027-11-25',
        amountCents: -100_000,
        description: 'PAGTO FORNECEDOR',
      });
    });

    it('lê a data ISO também', () => {
      const r = parseStatement(`${cabecalho}\n2027-11-25;-10.00;x`);

      expect(r.lines[0]!.postedAt).toBe('2027-11-25');
    });

    it('usa a coluna id como identificador quando ela existe', () => {
      const r = parseStatement(`data;valor;historico;id\n2027-11-25;-10,00;x;BANCO-42`);

      expect(r.lines[0]!.fitid).toBe('BANCO-42');
    });

    /**
     * Dois pagamentos idênticos no mesmo dia são normais. Sem a posição na
     * chave derivada, eles colapsariam num só e metade do que saiu do caixa
     * desapareceria.
     */
    it('dois lançamentos idênticos no mesmo dia não colapsam num só', () => {
      const r = parseStatement(
        `${cabecalho}\n2027-11-25;-10,00;ALUGUEL\n2027-11-25;-10,00;ALUGUEL`,
      );

      expect(r.lines).toHaveLength(2);
      expect(r.lines[0]!.fitid).not.toBe(r.lines[1]!.fitid);
    });

    it('recusa cabeçalho sem as colunas mínimas, dizendo quais faltam', () => {
      expect(() => parseStatement('foo;bar\n1;2')).toThrow(/data, valor/);
    });

    it('recusa a linha com contagem de campos diferente do cabeçalho', () => {
      const r = parseStatement(`${cabecalho}\n2027-11-25;-10,00;x;sobra`);

      expect(r.lines).toHaveLength(0);
      expect(r.rejected[0]!.reason).toContain('4 campos');
    });

    it('recusa data em formato desconhecido', () => {
      const r = parseStatement(`${cabecalho}\n11.25.2027;-10,00;x`);

      expect(r.rejected[0]!.reason).toMatch(/AAAA-MM-DD ou DD\/MM\/AAAA/);
    });

    it('aceita vírgula como delimitador quando não há ponto e vírgula', () => {
      const r = parseStatement('data,valor,historico\n2027-11-25,-10.00,PAGTO');

      expect(r.lines[0]!.amountCents).toBe(-1_000);
    });

    it('lê a coluna documento como CNPJ da contraparte', () => {
      const r = parseStatement(
        'data;valor;historico;documento\n2027-11-25;-10,00;x;98765432000199',
      );

      expect(r.lines[0]!.counterpartyDoc).toBe('98765432000199');
    });
  });

  describe('valores', () => {
    const csv = (valor: string) => parseStatement(`data;valor;historico\n2027-11-25;${valor};x`);

    it('lê o padrão brasileiro com milhar', () => {
      expect(csv('-1.234.567,89').lines[0]!.amountCents).toBe(-123_456_789);
    });

    it('lê o padrão americano com milhar', () => {
      expect(csv('-1,234,567.89').lines[0]!.amountCents).toBe(-123_456_789);
    });

    it('não perde centavo em valor grande', () => {
      expect(csv('-80.000.000,07').lines[0]!.amountCents).toBe(-8_000_000_007);
    });

    /** Errar por mil vezes faria o casamento apontar a nota errada. */
    it('recusa o valor ambíguo em vez de adivinhar a escala', () => {
      expect(csv('-1.000').rejected[0]!.reason).toMatch(/ambíguo/);
    });

    it('aceita crédito com sinal de mais', () => {
      expect(csv('+1.000,00').lines[0]!.amountCents).toBe(100_000);
    });

    it('tolera R$ e espaço', () => {
      expect(csv('-R$ 1.000,00').lines[0]!.amountCents).toBe(-100_000);
    });

    it('recusa mais de duas casas decimais', () => {
      expect(csv('-10,001').rejected[0]!.reason).toMatch(/duas casas decimais/);
    });

    it('recusa valor não numérico', () => {
      expect(csv('abc').rejected[0]!.reason).toMatch(/não numérico/);
    });
  });

  it('recusa arquivo vazio', () => {
    expect(() => parseStatement('   \n\n')).toThrow(StatementFormatError);
  });
});
