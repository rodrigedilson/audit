/**
 * Regras de calendário da cobrança, puras.
 *
 * **Pós-pago, pelo mês anterior.** A fatura que vence em novembro cobra os
 * CNPJs ativos em outubro. O preço é por CNPJ com competência no mês, e o mês
 * só tem número depois de fechado: cobrar o mês corrente seria cobrar por
 * estimativa.
 *
 * **O primeiro mês cobrado é o primeiro mês cheio depois do trial e da
 * ativação.** Um escritório cujo trial acaba em 15 de outubro e que ativa antes
 * disso paga primeiro por novembro, com vencimento em dezembro: os dias de
 * outubro depois do trial ficam de graça, em vez de virar uma fatura
 * proporcional difícil de explicar.
 */

/** Dia de vencimento. Até 28 para existir em todo mês. */
export const DIA_DE_VENCIMENTO = 10;

/** `YYYY-MM` do mês anterior ao da data. */
export function mesDeReferencia(vencimento: string): string {
  const [ano, mes] = vencimento.split('-').map(Number) as [number, number];
  const anterior = new Date(Date.UTC(ano, mes - 2, 1));
  return anterior.toISOString().slice(0, 7);
}

/**
 * Primeiro vencimento: o `dia` do mês seguinte ao primeiro mês cheio depois de
 * `max(fim do trial, hoje)`.
 */
export function primeiroVencimento(
  fimDoTrial: string | null,
  hoje: string,
  dia: number = DIA_DE_VENCIMENTO,
): string {
  const base = fimDoTrial !== null && fimDoTrial > hoje ? fimDoTrial : hoje;
  const [ano, mes] = base.split('-').map(Number) as [number, number];
  // Mês cheio seguinte a `base` é `mes + 1`; o vencimento é no mês depois dele.
  const vencimento = new Date(Date.UTC(ano, mes + 1, dia));
  return vencimento.toISOString().slice(0, 10);
}

/**
 * CPF ou CNPJ com dígitos verificadores válidos. Só dígitos.
 *
 * O Asaas também recusa documento inválido, mas com uma mensagem genérica e só
 * depois de um cliente ter sido tentado. Validar aqui é a fronteira do sistema.
 */
export function documentoValido(documento: string): boolean {
  if (!/^(\d{11}|\d{14})$/.test(documento) || /^(\d)\1+$/.test(documento)) {
    return false;
  }
  const digitos = [...documento].map(Number);

  const dv = (base: number[], pesos: number[]): number => {
    const soma = base.reduce((acc, d, i) => acc + d * pesos[i]!, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  if (digitos.length === 11) {
    const d1 = dv(digitos.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = dv(digitos.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === digitos[9] && d2 === digitos[10];
  }

  const d1 = dv(digitos.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(digitos.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === digitos[12] && d2 === digitos[13];
}
