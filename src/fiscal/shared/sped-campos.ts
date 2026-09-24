/**
 * Primitivos de leitura de campo do SPED, comuns a todos os leiautes.
 *
 * Ficam aqui, e não dentro de um parser, porque há mais de uma escrituração a
 * ler — EFD-Contribuições e EFD ICMS/IPI — e a conversão de valor monetário é
 * justamente onde duplicar custa dinheiro: duas cópias divergem, uma ganha um
 * arredondamento que a outra não tem, e a divergência aparece no dossiê do
 * cliente como se fosse erro dele.
 *
 * Todo campo é lido **por posição**, como o leiaute define. Por isso cada um
 * valida: data tem de parsear, valor tem de ser numérico, chave tem de ter os
 * dígitos certos. Campo que não valida levanta erro com o nome do campo, e não
 * é aceito pela metade nem silenciado como zero.
 */

export class SpedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpedFormatError';
  }
}

/** Registro recusado, com a linha e o motivo — nunca descartado em silêncio. */
export interface RejectedRecord {
  line: number;
  record: string;
  reason: string;
}

/** Linhas por arquivo. Uma EFD de um CNPJ não passa disso. */
export const MAX_LINHAS_SPED = 2_000_000;

/**
 * Linha do SPED: `|REG|campo|campo|`.
 *
 * O `split` produz vazio na primeira posição, então `REG` — que é o campo 1 do
 * leiaute — fica em `campos[1]`, e **o campo N do leiaute fica em `campos[N]`**.
 *
 * Vale escrever isto porque errar aqui por um é silencioso: a primeira versão
 * do leitor de EFD-Contribuições lia tudo em `N + 1`, e o teste, escrito depois,
 * codificou o mesmo deslocamento e passou. Só conferir contra o leiaute pegou.
 */
export function separar(linha: string): string[] | undefined {
  const limpa = linha.trim();
  if (limpa.length === 0 || !limpa.startsWith('|')) {
    return undefined;
  }
  return limpa.split('|');
}

export function texto(bruto: string | undefined): string {
  return (bruto ?? '').trim();
}

/**
 * Valor monetário, pela string.
 *
 * O SPED usa vírgula decimal e não separador de milhar. Converter por
 * `Number(x) * 100` erraria centavo em valor grande, e num dossiê de crédito
 * cada centavo errado é uma divergência falsa contra a própria escrituração do
 * cliente.
 */
export function centavos(bruto: string | undefined, campo: string): number {
  const limpo = texto(bruto);
  if (limpo.length === 0) {
    return 0;
  }

  if (!/^-?\d+(,\d{1,2})?$/.test(limpo)) {
    throw new Error(`Campo ${campo} não é valor SPED válido: '${limpo}'.`);
  }

  const negativo = limpo.startsWith('-');
  const [inteiroParte = '0', decimal = ''] = limpo.replace('-', '').split(',');
  const total = Number(inteiroParte) * 100 + Number(decimal.padEnd(2, '0'));

  if (!Number.isSafeInteger(total)) {
    throw new Error(`Campo ${campo} fora da faixa representável: '${limpo}'.`);
  }

  return negativo ? -total : total;
}

export function numero(bruto: string | undefined, campo: string): number {
  const limpo = texto(bruto);
  if (limpo.length === 0) {
    return 0;
  }

  const valor = Number(limpo.replace(',', '.'));
  if (!Number.isFinite(valor)) {
    throw new Error(`Campo ${campo} não é numérico: '${limpo}'.`);
  }
  return valor;
}

export function inteiro(bruto: string | undefined, campo: string): number {
  const valor = Number.parseInt(texto(bruto), 10);
  if (!Number.isInteger(valor)) {
    throw new Error(`Campo ${campo} não é inteiro: '${texto(bruto)}'.`);
  }
  return valor;
}

/** `DDMMAAAA`, que é o formato de data do SPED. */
export function data(bruto: string | undefined, campo: string): string {
  const limpo = texto(bruto);
  const achado = /^(\d{2})(\d{2})(\d{4})$/.exec(limpo);

  if (!achado) {
    throw new Error(`Campo ${campo} não é data SPED (DDMMAAAA): '${limpo}'.`);
  }

  const [, dia, mes, ano] = achado as unknown as [string, string, string, string];
  if (Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) {
    throw new Error(`Campo ${campo} tem data inválida: '${limpo}'.`);
  }

  return `${ano}-${mes}-${dia}`;
}

/** `MMAAAA`, que é o formato de competência do SPED. */
export function competencia(bruto: string | undefined, campo: string): string {
  const limpo = texto(bruto);
  const achado = /^(\d{2})(\d{4})$/.exec(limpo);

  if (!achado) {
    throw new Error(`Campo ${campo} não é competência SPED (MMAAAA): '${limpo}'.`);
  }

  const [, mes, ano] = achado as unknown as [string, string, string];
  if (Number(mes) < 1 || Number(mes) > 12) {
    throw new Error(`Campo ${campo} tem mês inválido: '${limpo}'.`);
  }

  return `${ano}-${mes}`;
}

export function digitos(bruto: string | undefined, quantos: number, campo: string): string {
  const so = texto(bruto).replace(/\D/g, '');
  if (so.length !== quantos) {
    throw new Error(`Campo ${campo} com ${so.length} dígitos; esperado ${quantos}.`);
  }
  return so;
}
