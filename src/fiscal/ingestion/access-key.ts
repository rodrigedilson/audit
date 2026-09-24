/**
 * Chave de acesso do DF-e: 44 posições que carregam UF, competência de emissão,
 * CNPJ do emitente, modelo, série, número, tipo de emissão, código numérico e
 * dígito verificador.
 *
 * **Não é mais só numérica.** Como o CNPJ do emitente ocupa as posições 7 a 18 e
 * desde 31/07/2026 ele pode ter letras, a chave passou a aceitá-las ali —
 * `[0-9]{6}[A-Z0-9]{12}[0-9]{26}` — e o dígito verificador passou a ser
 * calculado sobre o valor ASCII menos 48 de cada caractere. É a Nota Técnica
 * Conjunta CNPJ Alfanumérico 2025.001.
 *
 * Para chave só de dígitos o resultado é idêntico ao de antes, porque o ASCII de
 * `0` a `9` menos 48 é o próprio dígito. Nenhuma chave já validada deixa de
 * valer — e há teste fixando isso.
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

/**
 * Letras só nas doze posições do CNPJ, e só maiúsculas, como a Nota Técnica
 * define. Quem lê a chave de um arquivo sobe a caixa antes de chegar aqui:
 * minúscula mudaria o valor ASCII e o dígito verificador não fecharia.
 */
const CHAVE_44 = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;

/**
 * Dígito verificador por módulo 11 com pesos cíclicos de 2 a 9, da direita para
 * a esquerda. Resto 0 ou 1 resulta em DV 0.
 *
 * O valor de cada caractere é o código ASCII menos 48, e não `Number(c)`: é o
 * que a Nota Técnica Conjunta CNPJ Alfanumérico 2025.001 manda, e é o que faz a
 * letra ter valor. `Number('A')` seria `NaN`, e a soma inteira viraria `NaN` —
 * o DV sairia `'0'` por acidente e uma chave qualquer passaria.
 */
export function computeCheckDigit(first43: string): string {
  let sum = 0;
  let weight = 2;

  for (let i = first43.length - 1; i >= 0; i--) {
    sum += (first43.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }

  const remainder = sum % 11;
  return remainder <= 1 ? '0' : String(11 - remainder);
}

export function isValidAccessKey(key: string): boolean {
  if (!CHAVE_44.test(key)) {
    return false;
  }
  return computeCheckDigit(key.slice(0, 43)) === key[43];
}

export function parseAccessKey(key: string): AccessKeyParts {
  if (!CHAVE_44.test(key)) {
    throw new AccessKeyError(
      'Chave de acesso deve ter 44 posições, com letras admitidas apenas nas doze ' +
        `do CNPJ do emitente; recebida '${key}' com ${key.length}.`,
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
