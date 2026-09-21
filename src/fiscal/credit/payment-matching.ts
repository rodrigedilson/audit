import type { StatementLine } from './statement-parser.js';

/**
 * Casamento entre lançamento de extrato e documento de entrada.
 *
 * **Todo casamento é hipótese.** Valor e data iguais não provam que aquele
 * pagamento é daquela nota, e casar errado reportaria crédito liberado que não
 * está — o erro mais caro que este módulo pode cometer, porque o contador
 * aproveitaria um crédito que será glosado.
 *
 * Daí duas regras que o módulo não abre mão:
 *
 * 1. O casamento carrega **grau de confiança**, e a tela mostra o grau.
 * 2. O ambíguo **não é resolvido**. Dois documentos do mesmo fornecedor com o
 *    mesmo valor no mesmo período são indistinguíveis por valor e data; escolher
 *    um no critério de "o primeiro que apareceu" produziria uma afirmação sem
 *    base, e a saída correta é devolver os candidatos para o humano decidir.
 */

export type MatchConfidence = 'exact' | 'amount_and_date' | 'amount_only' | 'ambiguous';

export interface PayableDocument {
  accessKey: string;
  /** Número da nota como consta no documento, para procurar no histórico. */
  number: string | null;
  supplierCnpj: string;
  supplierName: string | null;
  issuedAt: string;
  totalCents: number;
}

export interface PaymentMatch {
  accessKey: string;
  fitid: string;
  confidence: MatchConfidence;
  rationale: string;
  /** Preenchido só no ambíguo: as chaves candidatas, para o humano escolher. */
  candidates?: string[];
}

export interface MatchingInput {
  documents: readonly PayableDocument[];
  lines: readonly StatementLine[];
  /** Dias após a emissão em que um pagamento ainda é atribuível à nota. */
  windowDays?: number;
}

/**
 * Janela padrão de atribuição.
 *
 * 90 dias cobrem o prazo comercial usual sem transformar qualquer pagamento do
 * trimestre em candidato. Não é norma: é heurística, e por isso é parâmetro.
 */
export const JANELA_PADRAO_DIAS = 90;

export function matchPayments(input: MatchingInput): PaymentMatch[] {
  const janela = input.windowDays ?? JANELA_PADRAO_DIAS;
  const saida: PaymentMatch[] = [];
  const jaCasados = new Set<string>();

  for (const linha of input.lines) {
    // Entrada de caixa não é pagamento a fornecedor. Considerá-la casaria um
    // recebimento com uma nota de compra.
    if (linha.amountCents >= 0) {
      continue;
    }

    const match = casar(linha, input.documents, janela, jaCasados);
    if (match === undefined) {
      continue;
    }

    saida.push(match);
    if (match.confidence !== 'ambiguous') {
      // Um lançamento paga uma nota: sem isso, o mesmo pagamento liberaria
      // crédito de várias notas de igual valor.
      jaCasados.add(match.accessKey);
    }
  }

  return saida;
}

function casar(
  linha: StatementLine,
  documentos: readonly PayableDocument[],
  janela: number,
  jaCasados: ReadonlySet<string>,
): PaymentMatch | undefined {
  const disponiveis = documentos.filter((d) => !jaCasados.has(d.accessKey));

  /**
   * Identificação explícita vence tudo.
   *
   * Se a chave de acesso ou o número da nota está no histórico do lançamento, o
   * banco (ou quem conciliou) já disse de qual nota se trata, e nenhuma
   * heurística de valor deve sobrepor isso — inclusive quando o valor difere,
   * que é o caso de pagamento parcial ou com desconto.
   */
  const porIdentificacao = disponiveis.find((d) => identificadoNoHistorico(linha, d));
  if (porIdentificacao !== undefined) {
    return {
      accessKey: porIdentificacao.accessKey,
      fitid: linha.fitid,
      confidence: 'exact',
      rationale:
        'A chave de acesso ou o número da nota aparece no histórico do lançamento ' +
        `"${linha.description}".`,
    };
  }

  const mesmoValor = disponiveis.filter((d) => d.totalCents === Math.abs(linha.amountCents));
  if (mesmoValor.length === 0) {
    return undefined;
  }

  const naJanela = mesmoValor.filter((d) => dentroDaJanela(d.issuedAt, linha.postedAt, janela));
  const candidatos = naJanela.length > 0 ? naJanela : mesmoValor;

  if (candidatos.length > 1) {
    return {
      accessKey: candidatos[0]!.accessKey,
      fitid: linha.fitid,
      confidence: 'ambiguous',
      rationale:
        `${candidatos.length} documentos com valor idêntico são candidatos a este ` +
        'pagamento. Valor e data não os distinguem, e escolher um seria afirmar ' +
        'sem base — indique a nota no histórico do lançamento ou resolva na tela.',
      candidates: candidatos.map((d) => d.accessKey),
    };
  }

  const unico = candidatos[0]!;
  const dentro = naJanela.length > 0;

  return {
    accessKey: unico.accessKey,
    fitid: linha.fitid,
    confidence: dentro ? 'amount_and_date' : 'amount_only',
    rationale: dentro
      ? `Valor idêntico ao da nota e pagamento em ${linha.postedAt}, dentro de ` +
        `${janela} dias da emissão em ${unico.issuedAt.slice(0, 10)}.`
      : `Valor idêntico ao da nota, mas o pagamento em ${linha.postedAt} está fora da ` +
        `janela de ${janela} dias da emissão em ${unico.issuedAt.slice(0, 10)}. ` +
        'Hipótese fraca.',
  };
}

function identificadoNoHistorico(linha: StatementLine, documento: PayableDocument): boolean {
  const historico = linha.description.replace(/[\s.\-/]/g, '');

  if (historico.includes(documento.accessKey)) {
    return true;
  }

  /**
   * Número de nota curto não serve como identificação.
   *
   * "NF 15" casaria com qualquer histórico que contenha "15" — inclusive uma
   * data ou um valor. Abaixo de quatro dígitos o sinal é ruído, e um casamento
   * `exact` errado é pior do que nenhum casamento.
   */
  const numero = documento.number?.replace(/\D/g, '');
  if (numero !== undefined && numero.length >= 4 && historico.includes(numero)) {
    return true;
  }

  return false;
}

function dentroDaJanela(emissao: string, pagamento: string, janela: number): boolean {
  const emitida = Date.parse(emissao);
  const pago = Date.parse(`${pagamento}T12:00:00Z`);

  if (Number.isNaN(emitida) || Number.isNaN(pago)) {
    return false;
  }

  const dias = (pago - emitida) / 86_400_000;
  // Pagamento anterior à emissão é adiantamento e não fecha a janela para trás
  // por acidente: -1 dia cobre o fuso do carimbo de emissão.
  return dias >= -1 && dias <= janela;
}
