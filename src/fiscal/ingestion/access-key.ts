/**
 * Chave de acesso do DF-e: 44 dígitos que carregam UF, competência de emissão,
 * CNPJ do emitente, modelo, série, número, tipo de emissão, código numérico e
 * dígito verificador.
 *
 * Validar a chave antes de qualquer outra coisa é o filtro mais barato da
 * ingestão: um XML truncado, com chave trocada ou com dígito inválido é
 * rejeitado sem parse e sem ida ao banco.
 */

export interface AccessKeyParts {
  uf: string;
  /** `YYYY-MM` derivado de AAMM na chave. */
  period: string;
  issuerCnpj: string;
  model: string;
  series: string;
  number: string;
  checkDigit: string;
}

export class AccessKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessKeyError';
  }
}

const DIGITS_44 = /^[0-9]{44}$/;

/**
 * Dígito verificador por módulo 11 com pesos cíclicos de 2 a 9, da direita para
 * a esquerda — o algoritmo da NT da NF-e. Resto 0 ou 1 resulta em DV 0.
 */
export function computeCheckDigit(first43: string): string {
  let sum = 0;
  let weight = 2;

  for (let i = first43.length - 1; i >= 0; i--) {
    sum += Number(first43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }

  const remainder = sum % 11;
  return remainder <= 1 ? '0' : String(11 - remainder);
}

export function isValidAccessKey(key: string): boolean {
  if (!DIGITS_44.test(key)) {
    return false;
  }
  return computeCheckDigit(key.slice(0, 43)) === key[43];
}

export function parseAccessKey(key: string): AccessKeyParts {
  if (!DIGITS_44.test(key)) {
    throw new AccessKeyError(
      `Chave de acesso deve ter 44 dígitos; recebida com ${key.length}.`,
    );
  }

  const expected = computeCheckDigit(key.slice(0, 43));
  if (expected !== key[43]) {
    throw new AccessKeyError(
      `Dígito verificador da chave de acesso inválido: esperado ${expected}, recebido ${key[43]}. ` +
        'A chave está corrompida ou foi digitada errado.',
    );
  }

  const year = Number(key.slice(2, 4));
  const month = key.slice(4, 6);

  if (Number(month) < 1 || Number(month) > 12) {
    throw new AccessKeyError(`Mês de emissão inválido na chave de acesso: ${month}.`);
  }

  return {
    uf: key.slice(0, 2),
    // A chave traz o ano com dois dígitos. O DF-e existe desde 2006, então
    // qualquer valor cai no século 21 — não há ambiguidade a resolver.
    period: `20${String(year).padStart(2, '0')}-${month}`,
    issuerCnpj: key.slice(6, 20),
    model: key.slice(20, 22),
    series: key.slice(22, 25),
    number: key.slice(25, 34),
    checkDigit: key[43]!,
  };
}
