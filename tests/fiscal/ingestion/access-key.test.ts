import { describe, it, expect } from 'vitest';
import {
  computeCheckDigit,
  isValidAccessKey,
  parseAccessKey,
  AccessKeyError,
} from '../../../src/fiscal/ingestion/access-key.js';

/** Monta uma chave válida a partir dos 43 primeiros dígitos. */
function withCheckDigit(first43: string): string {
  return first43 + computeCheckDigit(first43);
}

const BASE_43 = '3527081234567800019555001000000015123456789';

describe('computeCheckDigit', () => {
  it('produz um único dígito', () => {
    expect(computeCheckDigit(BASE_43)).toMatch(/^[0-9]$/);
  });

  it('é determinístico', () => {
    expect(computeCheckDigit(BASE_43)).toBe(computeCheckDigit(BASE_43));
  });

  it('muda quando qualquer dígito da chave muda', () => {
    const alterado = `9${BASE_43.slice(1)}`;

    expect(computeCheckDigit(alterado)).not.toBe(computeCheckDigit(BASE_43));
  });
});

describe('isValidAccessKey', () => {
  it('aceita chave com dígito verificador correto', () => {
    expect(isValidAccessKey(withCheckDigit(BASE_43))).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    const valida = withCheckDigit(BASE_43);
    const dvErrado = valida.slice(0, 43) + String((Number(valida[43]) + 1) % 10);

    expect(isValidAccessKey(dvErrado)).toBe(false);
  });

  it('recusa chave com tamanho diferente de 44', () => {
    expect(isValidAccessKey('123')).toBe(false);
    expect(isValidAccessKey(withCheckDigit(BASE_43) + '0')).toBe(false);
  });

  it('recusa chave com caractere não numérico', () => {
    expect(isValidAccessKey(`X${withCheckDigit(BASE_43).slice(1)}`)).toBe(false);
  });

  /**
   * É o filtro mais barato da ingestão: pega XML truncado ou chave digitada
   * errada antes de qualquer parse ou ida ao banco.
   */
  it('recusa chave com dois dígitos trocados de posição', () => {
    const valida = withCheckDigit(BASE_43);
    const trocada = valida.slice(0, 10) + valida[11] + valida[10] + valida.slice(12);

    expect(isValidAccessKey(trocada)).toBe(false);
  });
});

describe('parseAccessKey', () => {
  it('decompõe a chave nos seus campos', () => {
    const parts = parseAccessKey(withCheckDigit(BASE_43));

    expect(parts).toMatchObject({
      uf: '35',
      period: '2027-08',
      issuerCnpj: '12345678000195',
      model: '55',
      series: '001',
      number: '000000015',
    });
  });

  it('a competência sai da própria chave, no formato do contrato', () => {
    expect(parseAccessKey(withCheckDigit(BASE_43)).period).toMatch(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
  });

  it('recusa tamanho inválido explicando o tamanho recebido', () => {
    expect(() => parseAccessKey('123')).toThrow(/44 dígitos; recebida com 3/);
  });

  it('recusa dígito verificador inválido dizendo o esperado', () => {
    const valida = withCheckDigit(BASE_43);
    const dvErrado = valida.slice(0, 43) + String((Number(valida[43]) + 1) % 10);

    expect(() => parseAccessKey(dvErrado)).toThrow(AccessKeyError);
    expect(() => parseAccessKey(dvErrado)).toThrow(/Dígito verificador/);
  });

  it('recusa mês de emissão fora de 01..12', () => {
    const mesInvalido = withCheckDigit(`3527131234567800019555001000000015123456789`);

    expect(() => parseAccessKey(mesInvalido)).toThrow(/Mês de emissão inválido/);
  });
});
