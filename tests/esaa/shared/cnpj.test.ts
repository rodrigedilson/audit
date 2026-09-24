import { describe, it, expect } from 'vitest';
import {
  CnpjInvalidoError,
  cnpjValido,
  digitosVerificadoresDeCnpj,
  exigirCnpj,
  formatarCnpj,
  normalizarCnpj,
} from '../../../src/esaa/shared/domain/cnpj.js';

describe('dígitos verificadores', () => {
  /**
   * O exemplo trabalhado do documento do Serpro, *Cálculo dos dígitos
   * verificadores de CNPJ alfanumérico*: `12ABC34501DE` tem DV `35`, e o
   * resultado final é `12.ABC.345/01DE-35`.
   *
   * É o teste que ancora o algoritmo numa fonte, e não na minha aritmética.
   */
  it('reproduz o exemplo oficial do alfanumérico', () => {
    expect(digitosVerificadoresDeCnpj('12ABC34501DE')).toBe('35');
  });

  /**
   * O cálculo alfanumérico é uma generalização do numérico: com só dígitos, o
   * valor ASCII menos 48 é o próprio dígito, e os pesos são os de sempre. Se
   * isto falhasse, todo CNPJ já cadastrado passaria a ser recusado.
   */
  it('continua valendo para os CNPJs numéricos de sempre', () => {
    expect(digitosVerificadoresDeCnpj('123456780001')).toBe('95');
    expect(cnpjValido('12345678000195')).toBe(true);
  });

  it('recusa base de tamanho errado em vez de completar', () => {
    expect(() => digitosVerificadoresDeCnpj('12ABC34501D')).toThrow(CnpjInvalidoError);
  });
});

describe('cnpjValido', () => {
  it('aceita o alfanumérico e o numérico', () => {
    expect(cnpjValido('12ABC34501DE35')).toBe(true);
    expect(cnpjValido('12345678000195')).toBe(true);
  });

  it('aceita com máscara, que é como vem colado da tela', () => {
    expect(cnpjValido('12.ABC.345/01DE-35')).toBe(true);
    expect(cnpjValido('12.345.678/0001-95')).toBe(true);
  });

  it('recusa dígito verificador trocado', () => {
    expect(cnpjValido('12ABC34501DE36')).toBe(false);
    expect(cnpjValido('12345678000196')).toBe(false);
  });

  /**
   * O caso que obriga o DV a existir: com letras permitidas, um pedaço de texto
   * de 14 posições tem formato de CNPJ. Sem conferir o dígito, entraria como
   * cliente e abriria um event log inteiro no nome dele.
   */
  it('recusa texto de 14 posições que só parece CNPJ', () => {
    expect(cnpjValido('RAZAOSOCIALLT')).toBe(false);
    expect(cnpjValido('ABCDEFGHIJKLMN')).toBe(false);
  });

  it('recusa dígito verificador alfabético', () => {
    // As duas últimas posições continuam numéricas, mesmo no alfanumérico.
    expect(cnpjValido('12ABC34501DEAB')).toBe(false);
  });

  it('recusa tamanho errado', () => {
    expect(cnpjValido('1234567800019')).toBe(false);
    expect(cnpjValido('123456780001955')).toBe(false);
    expect(cnpjValido('')).toBe(false);
  });
});

describe('normalizarCnpj', () => {
  it('tira máscara e sobe a caixa', () => {
    expect(normalizarCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35');
  });

  it('não completa o que falta', () => {
    expect(normalizarCnpj('123')).toBe('123');
  });
});

describe('exigirCnpj', () => {
  it('devolve o normalizado', () => {
    expect(exigirCnpj('12.ABC.345/01DE-35', 'Cadastro')).toBe('12ABC34501DE35');
  });

  /** As duas mensagens são diferentes porque levam a ações diferentes. */
  it('separa erro de formato de erro de dígito verificador', () => {
    expect(() => exigirCnpj('123', 'Cadastro')).toThrow(/14 posições/);
    expect(() => exigirCnpj('12ABC34501DE36', 'Cadastro')).toThrow(
      /dígitos verificadores.*não conferem/,
    );
  });

  it('diz o contexto, para o erro apontar de onde veio', () => {
    expect(() => exigirCnpj('123', 'Importação da EFD')).toThrow(/^Importação da EFD:/);
  });
});

describe('formatarCnpj', () => {
  it('formata o alfanumérico como a Receita mostra', () => {
    expect(formatarCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
  });

  it('devolve o valor como veio quando não dá para formatar', () => {
    expect(formatarCnpj('123')).toBe('123');
  });
});
