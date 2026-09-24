import { describe, it, expect } from 'vitest';
import {
  parseSped,
  SpedFormatError,
  VERSOES_SUPORTADAS,
} from '../../../src/fiscal/dossier/sped-parser.js';

const CHAVE = '35230912345678000195550010000000011234567893';

/** `|REG|c2|c3|…|` — o pipe inicial e o final fazem parte do formato. */
const reg = (...campos: string[]): string => `|${campos.join('|')}|`;

const ABERTURA = reg(
  '0000',
  '006',
  '0',
  '',
  '',
  '01092023',
  '30092023',
  'EMPRESA DE TESTE LTDA',
  '12345678000195',
  'SP',
  '3550308',
  '',
  '00',
  '1',
);

/** C100: campo 2 = IND_OPER, 5 = COD_MOD, 9 = CHV_NFE, 10 = DT_DOC, 12 = VL_DOC. */
const c100 = (operacao = '0', chave: string | null = CHAVE, total = '1000,00'): string =>
  reg(
    'C100',
    operacao,
    '0',
    'FORN1',
    '55',
    '00',
    '1',
    '1',
    chave ?? '',
    '15092023',
    '15092023',
    total,
  );

/** C170: 25 = CST_PIS, 26 = VL_BC_PIS, 27 = ALIQ_PIS, 30 = VL_PIS; 31.. = Cofins. */
const c170 = (pis = '16,50', cofins = '76,00'): string =>
  reg(
    'C170',
    '1',
    'SKU-1',
    'Produto',
    '1,0000',
    'UN',
    '1000,00',
    '0,00',
    '0',
    '00',
    '1102',
    // Campos 12 a 24 do layout (COD_NAT..VL_IPI), entre CFOP e CST_PIS.
    ...Array(13).fill(''),
    '50',
    '1000,00',
    '1,6500',
    '',
    '',
    pis,
    '50',
    '1000,00',
    '7,6000',
    '',
    '',
    cofins,
  );

const M100 = reg(
  'M100',
  '101',
  '0',
  '1000,00',
  '1,6500',
  '',
  '',
  '16,50',
  '0,00',
  '0,00',
  '0,00',
  '16,50',
  '0',
  '0,00',
  '16,50',
);

const R1100 = reg(
  '1100',
  '012023',
  '0',
  '',
  '101',
  '5000,00',
  '0,00',
  '5000,00',
  '0,00',
  '0,00',
  '0,00',
  '5000,00',
  '0,00',
  '0,00',
  '0,00',
  '0,00',
  '0,00',
  '5000,00',
);

const arquivo = (...linhas: string[]): string => [ABERTURA, ...linhas].join('\n');

describe('EFD-Contribuições — leitura', () => {
  describe('abertura', () => {
    it('lê CNPJ, competência e nome do contribuinte', () => {
      const r = parseSped(arquivo());

      expect(r.header.cnpj).toBe('12345678000195');
      expect(r.header.period).toBe('2023-09');
      expect(r.header.companyName).toBe('EMPRESA DE TESTE LTDA');
      expect(r.header.kind).toBe('original');
    });

    it('distingue escrituração retificadora da original', () => {
      const retificadora = ABERTURA.replace('|0000|006|0|', '|0000|006|1|');

      expect(parseSped(retificadora).header.kind).toBe('retificadora');
    });

    /**
     * Entre versões de layout os campos mudam de posição. Ler no palpite
     * trocaria base por valor, e o dossiê sairia com número errado.
     */
    it('recusa versão de layout desconhecida em vez de adivinhar', () => {
      const antiga = ABERTURA.replace('|0000|006|', '|0000|002|');

      expect(() => parseSped(antiga)).toThrow(/não suportada/);
      expect(() => parseSped(antiga)).toThrow(/trocaria base por valor/);
    });

    it.each([...VERSOES_SUPORTADAS])('aceita a versão %s', (versao) => {
      const arq = ABERTURA.replace('|0000|006|', `|0000|${versao}|`);

      expect(parseSped(arq).header.layoutVersion).toBe(versao);
    });

    /** Sem o 0000 não se sabe de que CNPJ nem de que competência é o arquivo. */
    it('recusa arquivo sem registro 0000', () => {
      expect(() => parseSped(c100())).toThrow(SpedFormatError);
      expect(() => parseSped(c100())).toThrow(/sem registro 0000/);
    });

    it('recusa CNPJ com tamanho errado', () => {
      const ruim = ABERTURA.replace('|12345678000195|', '|123|');

      expect(() => parseSped(ruim)).toThrow(/CNPJ com 3 dígitos/);
    });

    it('recusa data de início fora do formato DDMMAAAA', () => {
      const ruim = ABERTURA.replace('|01092023|', '|2023-09-01|');

      expect(() => parseSped(ruim)).toThrow(/DT_INI/);
    });
  });

  describe('documentos e itens', () => {
    it('lê o documento com chave, data e valor', () => {
      const r = parseSped(arquivo(c100()));

      expect(r.documents).toHaveLength(1);
      expect(r.documents[0]).toMatchObject({
        operation: 'inbound',
        model: '55',
        accessKey: CHAVE,
        issuedAt: '2023-09-15',
        totalCents: 100_000,
      });
    });

    it('distingue entrada de saída pelo IND_OPER', () => {
      const r = parseSped(arquivo(c100('0'), c100('1')));

      expect(r.documents.map((d) => d.operation)).toEqual(['inbound', 'outbound']);
    });

    it('lê PIS e Cofins do item, com CST, base, alíquota e valor', () => {
      const r = parseSped(arquivo(c100(), c170()));

      const item = r.documents[0]!.items[0]!;
      expect(item.pis).toEqual({
        cst: '50',
        baseCents: 100_000,
        rate: 1.65,
        amountCents: 1_650,
      });
      expect(item.cofins).toEqual({
        cst: '50',
        baseCents: 100_000,
        rate: 7.6,
        amountCents: 7_600,
      });
    });

    it('agrupa vários itens sob o mesmo documento', () => {
      const r = parseSped(arquivo(c100(), c170(), c170('33,00', '152,00')));

      expect(r.documents).toHaveLength(1);
      expect(r.documents[0]!.items).toHaveLength(2);
    });

    it('nota em papel entra sem chave, e isso não é erro', () => {
      const r = parseSped(arquivo(c100('0', null), c170()));

      expect(r.documents[0]!.accessKey).toBeNull();
      expect(r.rejected).toHaveLength(0);
    });

    /** Item solto indica arquivo truncado ou fora de ordem. */
    it('recusa item que aparece fora de um documento', () => {
      const r = parseSped(arquivo(c170()));

      expect(r.rejected[0]!.record).toBe('C170');
      expect(r.rejected[0]!.reason).toMatch(/fora de um documento/);
    });

    it('um registro ruim não derruba os bons, e aponta a linha', () => {
      const r = parseSped(
        arquivo(c100(), c100('0', '123'), c100('0', `${CHAVE.slice(0, 43)}0`)),
      );

      expect(r.documents).toHaveLength(2);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0]!.line).toBe(3);
    });

    it('conta os registros lidos por tipo', () => {
      const r = parseSped(arquivo(c100(), c170(), c170(), M100));

      expect(r.counts['C100']).toBe(1);
      expect(r.counts['C170']).toBe(2);
      expect(r.counts['M100']).toBe(1);
    });
  });

  describe('valores', () => {
    const comValor = (valor: string) => parseSped(arquivo(c100('0', CHAVE, valor)));

    it('lê vírgula decimal, que é o formato do SPED', () => {
      expect(comValor('1234,56').documents[0]!.totalCents).toBe(123_456);
    });

    it('uma casa decimal é completada, não truncada', () => {
      expect(comValor('10,5').documents[0]!.totalCents).toBe(1_050);
    });

    it('valor inteiro sem vírgula vale reais cheios', () => {
      expect(comValor('1000').documents[0]!.totalCents).toBe(100_000);
    });

    /** Conversão pela string: `Number(x) * 100` erra centavo em valor grande. */
    it('não perde centavo em valor grande', () => {
      expect(comValor('80000000,07').documents[0]!.totalCents).toBe(8_000_000_007);
    });

    /**
     * O SPED não usa separador de milhar. Aceitar ponto abriria a porta para ler
     * `1.000` como mil onde o arquivo diz um.
     */
    it('recusa ponto como separador, que o SPED não usa', () => {
      expect(comValor('1.000,00').rejected[0]!.reason).toMatch(/não é valor SPED válido/);
    });

    it('campo de valor vazio conta como zero', () => {
      expect(comValor('').documents[0]!.totalCents).toBe(0);
    });

    it('recusa mais de duas casas decimais em valor', () => {
      expect(comValor('10,123').rejected[0]!.reason).toMatch(/não é valor SPED válido/);
    });
  });

  describe('créditos', () => {
    it('lê o crédito apurado do período, por tributo', () => {
      const m500 = M100.replace('|M100|', '|M500|');
      const r = parseSped(arquivo(M100, m500));

      expect(r.apuredCredits.map((c) => c.tax)).toEqual(['pis', 'cofins']);
      expect(r.apuredCredits[0]).toMatchObject({
        creditCode: '101',
        creditCents: 1_650,
        availableCents: 1_650,
        balanceCents: 1_650,
      });
    });

    it('lê o saldo credor de períodos anteriores com a competência de origem', () => {
      const r = parseSped(arquivo(R1100));

      expect(r.carriedCredits).toHaveLength(1);
      expect(r.carriedCredits[0]).toMatchObject({
        tax: 'pis',
        originPeriod: '2023-01',
        creditCode: '101',
        apuredCents: 500_000,
        finalBalanceCents: 500_000,
      });
    });

    it('o 1500 é o saldo credor de Cofins', () => {
      const r = parseSped(arquivo(R1100.replace('|1100|', '|1500|')));

      expect(r.carriedCredits[0]!.tax).toBe('cofins');
    });

    /** `MMAAAA` é o formato de competência do SPED, distinto do de data. */
    it('recusa competência de origem fora do formato MMAAAA', () => {
      const ruim = R1100.replace('|012023|', '|2023-01|');

      expect(parseSped(arquivo(ruim)).rejected[0]!.reason).toMatch(/MMAAAA/);
    });

    it('recusa mês inválido na competência de origem', () => {
      const ruim = R1100.replace('|012023|', '|132023|');

      expect(parseSped(arquivo(ruim)).rejected[0]!.reason).toMatch(/mês inválido/);
    });
  });

  it('ignora linhas em branco e linhas que não começam com pipe', () => {
    const r = parseSped([ABERTURA, '', 'comentário solto', c100()].join('\n'));

    expect(r.documents).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
  });

  it('registro não suportado é contado e ignorado, sem virar rejeição', () => {
    const r = parseSped(arquivo(reg('0140', 'EST1', 'FILIAL', '12345678000195')));

    expect(r.counts['0140']).toBe(1);
    expect(r.rejected).toHaveLength(0);
  });
});

/**
 * O arquivo do leiaute errado.
 *
 * A EFD ICMS/IPI e a EFD-Contribuições se parecem o bastante para uma ser lida
 * como a outra sem erro de parse. Onde divergem é no `0000`:
 *
 * | Campo | EFD-Contribuições | EFD ICMS/IPI |
 * |-------|-------------------|--------------|
 * | 04    | `IND_SIT_ESP`     | `DT_INI`     |
 * | 06    | `DT_INI`          | `NOME`       |
 * | 09    | `CNPJ`            | `UF`         |
 *
 * Conferido contra o Guia Prático EFD-ICMS/IPI 3.2.2 pelo script
 * `scripts/extrair-layout-efd.ts`. A mesma conferência desfez uma suposição que
 * estava escrita aqui: o `C100` e o `C170` **não** mudam de posição entre os
 * dois leiautes — são idênticos. O que quebra é o cabeçalho, e é por ele que a
 * recusa tem de acontecer, antes de qualquer valor ser lido.
 *
 * A defesa é a versão de leiaute, e estes testes existem para que ela não seja
 * afrouxada sem querer — por exemplo ao acrescentar uma versão nova à lista.
 */
describe('parseSped — arquivo do leiaute errado', () => {
  /**
   * Abertura real de EFD ICMS/IPI no leiaute 020, obrigatório desde 01/01/2026
   * (Tabela Versão do Leiaute, item 3.1.1 da Nota Técnica EFD ICMS IPI 2026.001).
   */
  const ABERTURA_ICMS_IPI = reg(
    '0000',
    '020',
    '0',
    '01012026',
    '31012026',
    'EMPRESA DE TESTE LTDA',
    '12345678000195',
    '',
    'SP',
    '110042490114',
    '3550308',
    '',
    '',
    'A',
    '0',
  );

  it('recusa o arquivo de EFD ICMS/IPI pela versão de leiaute', () => {
    expect(() => parseSped(ABERTURA_ICMS_IPI)).toThrow(SpedFormatError);
    expect(() => parseSped(ABERTURA_ICMS_IPI)).toThrow(/não suportada/);
  });

  /** A recusa diz por que, e não só que não deu. */
  it('a recusa explica que posição errada trocaria base por valor', () => {
    expect(() => parseSped(ABERTURA_ICMS_IPI)).toThrow(/trocaria base por valor/);
  });

  /**
   * As numerações de versão são independentes entre as duas escriturações, e se
   * sobrepõem: `006` é válido nas duas, significando leiautes diferentes. Por
   * isso a lista de cada leitor tem de ser conferida contra o guia dela, e não
   * herdada da outra.
   */
  it('a versão do ICMS/IPI não está entre as suportadas', () => {
    expect(VERSOES_SUPORTADAS.has('020')).toBe(false);
  });
});
