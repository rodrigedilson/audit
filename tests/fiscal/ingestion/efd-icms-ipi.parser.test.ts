import { describe, it, expect } from 'vitest';
import {
  parseEfdIcmsIpi,
  SpedFormatError,
  VERSOES_EFD_ICMS_SUPORTADAS,
} from '../../../src/fiscal/ingestion/efd-icms-ipi.parser.js';

const CHAVE = '35260112345678000195550010000000011234567893';

/** `|REG|c2|c3|…|` — o pipe inicial e o final fazem parte do formato. */
const reg = (...campos: string[]): string => `|${campos.join('|')}|`;

/**
 * Os valores de cada registro são **todos diferentes entre si** de propósito.
 * Se um campo fosse lido uma posição adiante, um teste com valores repetidos
 * continuaria passando — que foi exatamente como um deslocamento sobreviveu no
 * leitor de EFD-Contribuições até ser conferido contra o leiaute.
 */
const abertura = (versao = '020', cnpj = '12345678000195'): string =>
  reg(
    '0000',
    versao,
    '0',
    '01012026',
    '31012026',
    'EMPRESA DE TESTE LTDA',
    cnpj,
    '',
    'SP',
    '110042490114',
    '3550308',
    '',
    '',
    'A',
    '0',
  );

const c100 = (situacao = '00', chave: string | null = CHAVE): string =>
  reg(
    'C100',
    '0',
    '1',
    'FORN1',
    '55',
    situacao,
    '1',
    '4321',
    chave ?? '',
    '15012026',
    '16012026',
    '1000,00',
    '0',
    '0',
    '0',
    '975,00',
    '9',
    '0',
    '0',
    '0',
    '900,00',
    '162,00',
    '50,00',
    '9,00',
    '25,00',
    '16,50',
    '76,00',
    '0',
    '0',
  );

const c170 = (valor = '975,00'): string =>
  reg(
    'C170',
    '1',
    'PROD-A',
    'Descrição complementar',
    '10',
    'UN',
    valor,
    '0',
    '0',
    '00',
    '1102',
    '',
    '900,00',
    '18,00',
    '162,00',
    '50,00',
    '4,00',
    '9,00',
    '0',
    '50',
    '',
    '800,00',
    '5,00',
    '25,00',
    '50',
    '850,00',
    '1,65',
    '0',
    '0',
    '16,50',
    '50',
    '855,00',
    '7,60',
    '0',
    '0',
    '76,00',
    '1.1.01',
    '0',
  );

const C190 = reg(
  'C190',
  '00',
  '1102',
  '18,00',
  '1000,00',
  '900,00',
  '162,00',
  '50,00',
  '9,00',
  '100,00',
  '25,00',
  'OBS1',
);

const E110 = reg(
  'E110',
  '5000,00',
  '10,00',
  '20,00',
  '30,00',
  '4000,00',
  '11,00',
  '40,00',
  '50,00',
  '60,00',
  '970,00',
  '70,00',
  '900,00',
  '0',
  '80,00',
);

const E520 = reg('E520', '100,00', '700,00', '300,00', '10,00', '20,00', '0', '390,00');

const ARQUIVO = [abertura(), c100(), c170(), C190, E110, E520].join('\n');

describe('parseEfdIcmsIpi — abertura', () => {
  it('lê o 0000 nas posições do leiaute da EFD ICMS/IPI', () => {
    const { header } = parseEfdIcmsIpi(ARQUIVO);

    expect(header).toEqual({
      layoutVersion: '020',
      cnpj: '12345678000195',
      uf: 'SP',
      stateRegistration: '110042490114',
      period: '2026-01',
      companyName: 'EMPRESA DE TESTE LTDA',
      kind: 'original',
    });
  });

  /** Leiaute 118, de 2025 — o ano que o escritório ainda está conciliando. */
  it('lê o leiaute 019, conferido contra o Guia Prático 3.1.9', () => {
    const { header } = parseEfdIcmsIpi(abertura('019'));

    expect(header.layoutVersion).toBe('019');
    expect(header.cnpj).toBe('12345678000195');
    expect(header.period).toBe('2026-01');
  });

  it('recusa versão de leiaute que não conferiu contra o guia', () => {
    expect(() => parseEfdIcmsIpi(abertura('018'))).toThrow(SpedFormatError);
    expect(() => parseEfdIcmsIpi(abertura('018'))).toThrow(/não suportada/);
    expect(VERSOES_EFD_ICMS_SUPORTADAS.has('018')).toBe(false);
  });

  /**
   * O 021 bate onde a comparação alcança, mas a conversão do PDF da Nota Técnica
   * perde uma linha no meio do `C100`. Conferência incompleta não é conferência.
   */
  it('ainda recusa o leiaute 021, que só foi conferido em parte', () => {
    expect(() => parseEfdIcmsIpi(abertura('021'))).toThrow(/não suportada/);
  });

  it('recusa a EFD-Contribuições, cujo 0000 usa outras posições', () => {
    // '006' é versão de EFD-Contribuições. Se fosse aceita, `DT_INI` seria lido
    // do campo 4 — que ali é `IND_SIT_ESP` — e a competência sairia errada.
    expect(() => parseEfdIcmsIpi(abertura('006'))).toThrow(/não suportada/);
  });

  it('aceita CNPJ alfanumérico, que o leiaute 020 passou a permitir', () => {
    const { header } = parseEfdIcmsIpi(abertura('020', '12ABC34501DE35'));

    expect(header.cnpj).toBe('12ABC34501DE35');
  });

  it('recusa CNPJ com menos de 14 posições em vez de completar', () => {
    expect(() => parseEfdIcmsIpi(abertura('020', '1234567800019'))).toThrow(
      /esperado 14 posições/,
    );
  });

  it('recusa UF inválida, porque a escrituração é estadual', () => {
    const semUf = abertura().replace('|SP|', '||');

    expect(() => parseEfdIcmsIpi(semUf)).toThrow(/UF do registro 0000/);
  });

  it('aborta quando não há 0000, dizendo o que falta', () => {
    expect(() => parseEfdIcmsIpi(C190)).toThrow(/sem registro 0000/);
  });
});

describe('parseEfdIcmsIpi — documento e itens', () => {
  it('lê o C100 com situação e totais de ICMS e IPI', () => {
    const [documento] = parseEfdIcmsIpi(ARQUIVO).documents;

    expect(documento).toMatchObject({
      operation: 'inbound',
      issuedBySelf: false,
      model: '55',
      situation: '00',
      accessKey: CHAVE,
      documentNumber: '4321',
      issuedAt: '2026-01-15',
      totalCents: 100_000,
      icmsBaseCents: 90_000,
      icmsCents: 16_200,
      icmsStBaseCents: 5_000,
      icmsStCents: 900,
      ipiCents: 2_500,
    });
  });

  it('preserva o COD_SIT do documento cancelado em vez de descartá-lo', () => {
    const arquivo = [abertura(), c100('02')].join('\n');
    const [documento] = parseEfdIcmsIpi(arquivo).documents;

    expect(documento?.situation).toBe('02');
  });

  it('lê ICMS e IPI do item, que a EFD-Contribuições não traz', () => {
    const [item] = parseEfdIcmsIpi(ARQUIVO).documents[0]!.items;

    expect(item).toEqual({
      itemNumber: 1,
      code: 'PROD-A',
      cfop: '1102',
      totalCents: 97_500,
      icms: { cst: '00', baseCents: 90_000, rate: 18, amountCents: 16_200 },
      ipi: { cst: '50', baseCents: 80_000, rate: 5, amountCents: 2_500 },
    });
  });

  it('lê a consolidação analítica do C190', () => {
    const [analitico] = parseEfdIcmsIpi(ARQUIVO).documents[0]!.analytics;

    expect(analitico).toEqual({
      cstIcms: '00',
      cfop: '1102',
      icmsRate: 18,
      operationCents: 100_000,
      icmsBaseCents: 90_000,
      icmsCents: 16_200,
      icmsStBaseCents: 5_000,
      icmsStCents: 900,
      reducedBaseCents: 10_000,
      ipiCents: 2_500,
    });
  });

  it('recusa o item solto sem derrubar o arquivo inteiro', () => {
    const arquivo = [abertura(), c170()].join('\n');
    const { rejected, documents } = parseEfdIcmsIpi(arquivo);

    expect(documents).toHaveLength(0);
    expect(rejected).toEqual([
      { line: 2, record: 'C170', reason: 'Registro C170 fora de um documento C100.' },
    ]);
  });

  it('recusa o item com valor malformado, nomeando o campo', () => {
    const arquivo = [abertura(), c100(), c170('mil reais')].join('\n');
    const { rejected } = parseEfdIcmsIpi(arquivo);

    expect(rejected[0]?.reason).toMatch(/VL_ITEM/);
  });

  it('recusa chave de acesso com tamanho errado', () => {
    const arquivo = [abertura(), c100('00', '123')].join('\n');
    const { rejected, documents } = parseEfdIcmsIpi(arquivo);

    expect(documents).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/CHV_NFE com 3 posições/);
  });
});

describe('parseEfdIcmsIpi — apuração', () => {
  it('lê o E110 do ICMS', () => {
    const { icmsAssessment } = parseEfdIcmsIpi(ARQUIVO);

    expect(icmsAssessment).toEqual({
      totalDebitsCents: 500_000,
      documentDebitAdjustmentsCents: 1_000,
      adjustmentDebitsCents: 2_000,
      creditReversalsCents: 3_000,
      totalCreditsCents: 400_000,
      documentCreditAdjustmentsCents: 1_100,
      adjustmentCreditsCents: 4_000,
      debitReversalsCents: 5_000,
      previousCreditBalanceCents: 6_000,
      assessedBalanceCents: 97_000,
      deductionsCents: 7_000,
      icmsPayableCents: 90_000,
      carriedCreditBalanceCents: 0,
      extraAssessmentCents: 8_000,
    });
  });

  it('lê o E520 do IPI', () => {
    const { ipiAssessment } = parseEfdIcmsIpi(ARQUIVO);

    expect(ipiAssessment).toEqual({
      previousCreditBalanceCents: 10_000,
      debitsCents: 70_000,
      creditsCents: 30_000,
      otherDebitsCents: 1_000,
      otherCreditsCents: 2_000,
      carriedCreditBalanceCents: 0,
      ipiPayableCents: 39_000,
    });
  });

  it('devolve null, e não zero, quando o arquivo não traz apuração', () => {
    const { icmsAssessment, ipiAssessment } = parseEfdIcmsIpi(
      [abertura(), c100()].join('\n'),
    );

    // Arquivo sem E110 não é arquivo com ICMS zerado. Devolver zero faria o
    // sistema afirmar "nada a recolher" sobre algo que o arquivo não diz.
    expect(icmsAssessment).toBeNull();
    expect(ipiAssessment).toBeNull();
  });

  it('conta os registros lidos para o usuário conferir o que entrou', () => {
    const { counts } = parseEfdIcmsIpi(ARQUIVO);

    expect(counts).toEqual({ '0000': 1, C100: 1, C170: 1, C190: 1, E110: 1, E520: 1 });
  });
});
