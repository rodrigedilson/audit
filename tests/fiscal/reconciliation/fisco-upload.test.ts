import { describe, it, expect } from 'vitest';
import {
  parseFiscoUpload,
  UploadFormatError,
  MAX_LINHAS_UPLOAD,
} from '../../../src/fiscal/reconciliation/fisco-upload.js';

const CHAVE = '35270912345678000195550010000000011234567893';
const CABECALHO = 'chave_acesso;item;tributo;sentido;base;aliquota;valor';

const arquivo = (...linhas: string[]): string => [CABECALHO, ...linhas].join('\n');

describe('proposta do Fisco — leitura do CSV', () => {
  describe('modo nota a nota', () => {
    it('lê uma linha completa em centavos', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1000,00;18,00;180,00`));

      expect(r.lineLevel).toBe(true);
      expect(r.rejected).toHaveLength(0);
      expect(r.lines[0]).toEqual({
        accessKey: CHAVE,
        line: 1,
        tax: 'icms',
        direction: 'outbound',
        baseCents: 100_000,
        rate: 18,
        amountCents: 18_000,
      });
    });

    it('soma os totais por tributo a partir das linhas', () => {
      const r = parseFiscoUpload(
        arquivo(
          `${CHAVE};1;ICMS;S;1000,00;18,00;180,00`,
          `${CHAVE};2;ICMS;S;1000,00;18,00;180,00`,
          `${CHAVE};1;CBS;S;1000,00;9,21;92,10`,
        ),
      );

      expect(r.totals).toEqual({ icms: 36_000, cbs: 9_210 });
    });

    it('aceita as grafias de sentido que aparecem na prática', () => {
      const r = parseFiscoUpload(
        arquivo(
          `${CHAVE};1;ICMS;E;1000,00;18,00;180,00`,
          `${CHAVE};2;ICMS;entrada;1000,00;18,00;180,00`,
          `${CHAVE};3;ICMS;Saída;1000,00;18,00;180,00`,
          `${CHAVE};4;ICMS;outbound;1000,00;18,00;180,00`,
        ),
      );

      expect(r.lines.map((l) => l.direction)).toEqual([
        'inbound',
        'inbound',
        'outbound',
        'outbound',
      ]);
    });

    /**
     * Assumir um sentido transformaria crédito em débito, ou o contrário. O
     * sentido decide o significado inteiro da divergência.
     */
    it('recusa a linha quando o sentido não é reconhecível', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;?;1000,00;18,00;180,00`));

      expect(r.lines).toHaveLength(0);
      expect(r.rejected[0]!.reason).toContain('Sentido não reconhecido');
      expect(r.rejected[0]!.row).toBe(2);
    });

    it('recusa chave de acesso com tamanho errado, dizendo quantos dígitos veio', () => {
      const r = parseFiscoUpload(arquivo(`123;1;ICMS;S;1000,00;18,00;180,00`));

      expect(r.rejected[0]!.reason).toContain('3 dígitos');
    });

    it('ignora máscara na chave de acesso', () => {
      const mascarada = CHAVE.replace(/(.{4})/g, '$1 ').trim();

      const r = parseFiscoUpload(arquivo(`${mascarada};1;ICMS;S;10,00;0;1,80`));

      expect(r.rejected).toHaveLength(0);
      expect(r.lines[0]!.accessKey).toBe(CHAVE);
    });

    it('uma linha ruim não derruba as boas', () => {
      const r = parseFiscoUpload(
        arquivo(
          `${CHAVE};1;ICMS;S;1000,00;18,00;180,00`,
          `${CHAVE};x;ICMS;S;1000,00;18,00;180,00`,
          `${CHAVE};3;ICMS;S;1000,00;18,00;180,00`,
        ),
      );

      expect(r.lines).toHaveLength(2);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0]!.row).toBe(3);
    });
  });

  describe('modo só totais', () => {
    /**
     * A honestidade da onda começa aqui: sem `chave_acesso`, a comparação nota a
     * nota não é possível, e o resultado precisa carregar essa informação.
     */
    it('declara que a proposta não tem detalhe', () => {
      const r = parseFiscoUpload('tributo;valor\nICMS;1800,00\nCBS;921,00');

      expect(r.lineLevel).toBe(false);
      expect(r.lines).toHaveLength(0);
      expect(r.totals).toEqual({ icms: 180_000, cbs: 92_100 });
    });

    it('soma o tributo repetido em vez de sobrescrever', () => {
      const r = parseFiscoUpload('tributo;valor\nICMS;100,00\nICMS;50,00');

      expect(r.totals['icms']).toBe(15_000);
    });
  });

  describe('separador decimal', () => {
    it('lê o padrão brasileiro com milhar', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1.234.567,89;18;222.222,22`));

      expect(r.lines[0]!.baseCents).toBe(123_456_789);
      expect(r.lines[0]!.amountCents).toBe(22_222_222);
    });

    it('lê o padrão americano com milhar', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1,234,567.89;18;222,222.22`));

      expect(r.lines[0]!.baseCents).toBe(123_456_789);
    });

    /**
     * `1.000` é mil em pt-BR e um em en-US. Adivinhar erraria por mil vezes num
     * campo de dinheiro, e a divergência falsa levaria o contador a contestar o
     * que estava certo.
     */
    it('recusa o valor ambíguo em vez de adivinhar a escala', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1.000;18;180,00`));

      expect(r.lines).toHaveLength(0);
      expect(r.rejected[0]!.reason).toContain('ambíguo');
      expect(r.rejected[0]!.reason).toContain('duas casas decimais');
    });

    it('não confunde decimal de duas casas com milhar', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1000.50;18;180.09`));

      expect(r.lines[0]!.baseCents).toBe(100_050);
      expect(r.lines[0]!.amountCents).toBe(18_009);
    });

    /** Conversão pela string: `Math.round(x * 100)` erra centavos em valores grandes. */
    it('não perde centavo em valor grande', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;80.000.000,07;18;1,00`));

      expect(r.lines[0]!.baseCents).toBe(8_000_000_007);
    });

    it('recusa mais de duas casas decimais em valor', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1000,001;18;180,00`));

      expect(r.rejected[0]!.reason).toContain('duas casas decimais');
    });

    it('tolera R$, espaço e % nos campos', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;R$ 1.000,00;18,00%;R$ 180,00`));

      expect(r.lines[0]!.baseCents).toBe(100_000);
      expect(r.lines[0]!.rate).toBe(18);
    });

    it('aceita valor negativo, que aparece em estorno', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;E;-1000,00;18;-180,00`));

      expect(r.lines[0]!.amountCents).toBe(-18_000);
    });
  });

  describe('cabeçalho', () => {
    it('ignora acento, caixa e espaço nos nomes de coluna', () => {
      const r = parseFiscoUpload(
        'Chave Acesso;Item;Tributo;Sentido;Base;Alíquota;Valor\n' +
          `${CHAVE};1;ICMS;S;1000,00;18;180,00`,
      );

      expect(r.lines).toHaveLength(1);
    });

    it('não depende da ordem das colunas', () => {
      const r = parseFiscoUpload(
        'valor;aliquota;base;sentido;tributo;item;chave_acesso\n' +
          `180,00;18;1000,00;S;ICMS;1;${CHAVE}`,
      );

      expect(r.lines[0]!.amountCents).toBe(18_000);
      expect(r.lines[0]!.accessKey).toBe(CHAVE);
    });

    it('recusa o arquivo inteiro quando falta coluna da proposta nota a nota', () => {
      expect(() =>
        parseFiscoUpload(`chave_acesso;item;tributo;valor\n${CHAVE};1;ICMS;180,00`),
      ).toThrow(/sentido|base|aliquota/);
    });

    it('recusa cabeçalho que não é nem nota a nota nem totais', () => {
      expect(() => parseFiscoUpload('foo;bar\n1;2')).toThrow(UploadFormatError);
    });

    it('recusa arquivo vazio', () => {
      expect(() => parseFiscoUpload('   \n\n')).toThrow(/vazio/);
    });

    it('aceita vírgula como delimitador quando não há ponto e vírgula', () => {
      const r = parseFiscoUpload(
        `chave_acesso,item,tributo,sentido,base,aliquota,valor\n${CHAVE},1,ICMS,S,1000.00,18,180.00`,
      );

      expect(r.lines[0]!.amountCents).toBe(18_000);
    });

    /**
     * Campo a mais desloca as colunas, e o que sai é um número lido da coluna
     * errada — pior do que uma linha recusada, porque entra na comparação com
     * cara de válido.
     */
    it('recusa a linha com contagem de campos diferente do cabeçalho', () => {
      const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1000,00;18;180,00;sobra`));

      expect(r.lines).toHaveLength(0);
      expect(r.rejected[0]!.reason).toContain('8 campos');
      expect(r.rejected[0]!.reason).toContain('cabeçalho tem 7');
    });

    it('recusa o arquivo acima do limite de linhas', () => {
      const gigante = [CABECALHO, ...Array(MAX_LINHAS_UPLOAD + 1).fill('x')].join('\n');

      expect(() => parseFiscoUpload(gigante)).toThrow(/limite por proposta/);
    });
  });

  it('ignora linhas em branco no meio do arquivo', () => {
    const r = parseFiscoUpload(
      arquivo(`${CHAVE};1;ICMS;S;1000,00;18;180,00`, '', `${CHAVE};2;ICMS;S;1000,00;18;180,00`),
    );

    expect(r.lines).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  it('recusa alíquota fora de 0 a 100', () => {
    const r = parseFiscoUpload(arquivo(`${CHAVE};1;ICMS;S;1000,00;180;180,00`));

    expect(r.rejected[0]!.reason).toContain('Alíquota fora de 0 a 100');
  });

  it('recusa tributo vazio', () => {
    const r = parseFiscoUpload(arquivo(`${CHAVE};1;;S;1000,00;18;180,00`));

    expect(r.rejected[0]!.reason).toContain('Tributo vazio');
  });
});
