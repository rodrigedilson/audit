/**
 * CNPJ — numérico e alfanumérico.
 *
 * Desde **31/07/2026** a Receita emite CNPJ alfanumérico para inscrições novas
 * (IN RFB 2.229/2024). São as mesmas 14 posições: 12 alfanuméricas e 2 dígitos
 * verificadores, que continuam numéricos. Os CNPJs já existentes não mudaram.
 *
 * Para este sistema isso não é detalhe de formatação. O CNPJ é metade da chave
 * do event log — `(tenant_id, cnpj)` — e é o que o `pg_advisory_xact_lock`
 * serializa. Filtrar o valor para dígitos, como o código fazia, devolveria um
 * CNPJ curto para um cliente novo: o escritório não conseguiria cadastrar quem
 * abriu empresa de agosto em diante.
 *
 * **O dígito verificador passa a ser conferido, e não é zelo extra.** Enquanto
 * só havia dígitos, um valor de 14 caracteres já era quase sempre um CNPJ.
 * Aceitando letras, `RAZAOSOCIALLT` tem 14 posições e entraria como cliente. O
 * DV é o que sustenta a ampliação.
 *
 * O algoritmo é o do documento do Serpro, *Cálculo dos dígitos verificadores de
 * CNPJ alfanumérico*: módulo 11, pesos de 2 a 9 da direita para a esquerda
 * recomeçando depois do oitavo caractere, e o valor de cada caractere é o código
 * ASCII menos 48 — `0`–`9` viram 0–9 e `A`–`Z` viram 17–42.
 */

export const TAMANHO_DO_CNPJ = 14;

/** Posições alfanuméricas, antes dos dois dígitos verificadores. */
const TAMANHO_DA_BASE = 12;

const CNPJ_NORMALIZADO = /^[0-9A-Z]{12}[0-9]{2}$/;

export class CnpjInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CnpjInvalidoError';
  }
}

/**
 * Tira máscara e uniformiza a caixa.
 *
 * Aceitar `12.ABC.345/01DE-35` aqui evita que o mesmo CNPJ colado da tela vire
 * um escopo distinto do digitado sem máscara — o que fragmentaria o log de um
 * cliente em dois.
 */
export function normalizarCnpj(bruto: string): string {
  return (bruto ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Valor de um caractere para o cálculo: código ASCII menos 48.
 *
 * Só é chamado sobre caractere já validado como `[0-9A-Z]`; qualquer outro
 * produziria um número sem significado e um DV que "confere" por acidente.
 */
function valorDoCaractere(caractere: string): number {
  return caractere.charCodeAt(0) - 48;
}

/**
 * Um dígito verificador sobre a sequência dada.
 *
 * Os pesos vão de 2 a 9 **da direita para a esquerda** e recomeçam em 2 depois
 * do oitavo — por isso o peso sai da posição contada a partir do fim, e não da
 * posição no texto.
 */
function digito(sequencia: string): number {
  let soma = 0;

  for (let i = 0; i < sequencia.length; i++) {
    const daDireita = sequencia.length - 1 - i;
    const peso = (daDireita % 8) + 2;
    soma += valorDoCaractere(sequencia[i]!) * peso;
  }

  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * Os dois dígitos verificadores das 12 primeiras posições.
 *
 * O segundo é calculado sobre as 12 posições **mais o primeiro dígito**, como
 * manda o documento — não sobre a base outra vez.
 */
export function digitosVerificadoresDeCnpj(base: string): string {
  const normalizada = normalizarCnpj(base);

  if (normalizada.length !== TAMANHO_DA_BASE || !/^[0-9A-Z]+$/.test(normalizada)) {
    throw new CnpjInvalidoError(
      `A base do CNPJ precisa ter ${TAMANHO_DA_BASE} caracteres alfanuméricos; ` +
        `recebido '${base}'.`,
    );
  }

  const primeiro = digito(normalizada);
  const segundo = digito(`${normalizada}${primeiro}`);

  return `${primeiro}${segundo}`;
}

/** `true` quando o valor é um CNPJ de 14 posições com dígitos verificadores certos. */
export function cnpjValido(valor: string): boolean {
  const normalizado = normalizarCnpj(valor);

  if (!CNPJ_NORMALIZADO.test(normalizado)) {
    return false;
  }

  const base = normalizado.slice(0, TAMANHO_DA_BASE);
  return digitosVerificadoresDeCnpj(base) === normalizado.slice(TAMANHO_DA_BASE);
}

/**
 * Devolve o CNPJ normalizado, ou levanta dizendo o que está errado.
 *
 * A mensagem separa os dois casos de propósito: formato errado costuma ser
 * campo trocado, e dígito verificador errado costuma ser digitação. Quem recebe
 * o erro faz coisas diferentes em cada um.
 */
export function exigirCnpj(bruto: string, contexto: string): string {
  const normalizado = normalizarCnpj(bruto);

  if (!CNPJ_NORMALIZADO.test(normalizado)) {
    throw new CnpjInvalidoError(
      `${contexto}: CNPJ deve ter 14 posições — 12 alfanuméricas e 2 dígitos ` +
        `verificadores numéricos. Recebido '${String(bruto)}'.`,
    );
  }

  if (!cnpjValido(normalizado)) {
    throw new CnpjInvalidoError(
      `${contexto}: os dígitos verificadores de '${normalizado}' não conferem.`,
    );
  }

  return normalizado;
}

/** `12.ABC.345/01DE-35`, para telas e relatórios. */
export function formatarCnpj(valor: string): string {
  const c = normalizarCnpj(valor);

  if (c.length !== TAMANHO_DO_CNPJ) {
    return valor;
  }

  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}
