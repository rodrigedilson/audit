/**
 * Padrão de CNPJ aceito pelas rotas.
 *
 * Doze posições alfanuméricas e dois dígitos verificadores numéricos. Desde
 * **31/07/2026** a Receita emite CNPJ alfanumérico para inscrições novas (IN RFB
 * 2.229/2024), então `^[0-9]{14}$` — que era o padrão aqui — passaria a devolver
 * `400` para todo cliente aberto de agosto em diante.
 *
 * Minúsculas entram porque vêm no caminho da URL, e o `EventScope` sobe a caixa
 * ao normalizar: recusar `12abc34501de35` seria rejeitar o mesmo CNPJ por causa
 * do teclado.
 *
 * **O dígito verificador não é conferido aqui.** JSON Schema não calcula módulo
 * 11, e fingir que o `pattern` valida CNPJ daria falsa segurança. A conferência
 * de verdade está em `exigirCnpj`, na fronteira onde o CNPJ entra no sistema.
 */
export const PADRAO_DE_CNPJ = '^[0-9A-Za-z]{12}[0-9]{2}$';

import { CnpjInvalidoError, exigirCnpj } from '../../esaa/shared/domain/cnpj.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';

/**
 * Confere o CNPJ na fronteira e traduz a recusa para a camada 1.
 *
 * Fica aqui, e não no `EventScope`, porque o escopo também é construído ao
 * **ler** o log: conferir dígito lá deixaria ilegível um CNPJ que entrou torto
 * algum dia, e o log é append-only. Na entrada, ao contrário, recusar é o único
 * comportamento correto — cada CNPJ cadastrado abre um event log próprio e entra
 * na fatura do escritório.
 */
export function exigirCnpjNaRota(bruto: string, contexto: string): string {
  try {
    return exigirCnpj(bruto, contexto);
  } catch (causa) {
    if (causa instanceof CnpjInvalidoError) {
      throw new ValidationError(1, 'schema_violation', causa.message);
    }
    throw causa;
  }
}
