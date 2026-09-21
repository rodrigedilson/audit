import type { MatchConfidence } from './payment-matching.js';

/**
 * Estado do crédito de entrada, e o risco por fornecedor.
 *
 * O crédito de IBS/CBS é condicionado à extinção do tributo da etapa anterior, e
 * sob split payment a extinção acontece na liquidação financeira. É daí que sai
 * o diferencial: "players fiscais não olham o banco".
 *
 * **O que este módulo não sabe, e não finge saber:** se o fornecedor recolheu o
 * tributo dele. Essa informação é do Fisco e não há fonte para ela hoje. Por
 * isso `released` exige evidência explícita e vai ficar raro enquanto a fonte não
 * existir — o que é a verdade, e a tela tem de dizer em vez de esconder.
 *
 * **O que ele sabe, e é suficiente para um achado defensável:** se *nós* pagamos
 * o fornecedor. Sem liquidação não há split payment; sem split payment o crédito
 * não se extingue. Nosso não-pagamento é o sinal de risco observável.
 */

export type CreditState = 'expected' | 'conditioned' | 'released' | 'at_risk' | 'lost';

export interface CreditInput {
  accessKey: string;
  period: string;
  tax: string;
  supplierCnpj: string;
  supplierName: string | null;
  amountCents: number;
  issuedAt: string;
  /** `true` quando o documento traz o grupo UB (IBS/CBS). */
  hasReformGroup: boolean;
  /** Casamento de pagamento encontrado, quando há. */
  payment?: { confidence: MatchConfidence; postedAt: string };
}

export interface SupplierRisk {
  supplierCnpj: string;
  supplierName: string | null;
  documents: number;
  creditExpectedCents: number;
  creditConditionedCents: number;
  creditReleasedCents: number;
  creditAtRiskCents: number;
  oldestUnpaidDays: number | null;
  /**
   * Se ALGUM documento deste fornecedor traz o grupo IBS/CBS.
   *
   * Não se chama `usesSplitPayment` embora seja esse o nome no briefing: o
   * sistema observa se os documentos carregam o grupo UB, não se o fornecedor
   * usa split payment. Concluir o segundo do primeiro seria afirmar sobre a
   * operação de terceiro a partir do XML dele.
   */
  emitsReformGroup: boolean;
}

export interface CreditPosition {
  /** Carregado do documento: decide se há crédito da reforma a condicionar. */
  hasReformGroup: boolean;
  accessKey: string;
  period: string;
  tax: string;
  supplierCnpj: string;
  supplierName: string | null;
  amountCents: number;
  state: CreditState;
  reason: string;
  /** Dias desde a emissão sem pagamento identificado; `null` quando identificado. */
  unpaidDays: number | null;
}

/**
 * Dias sem pagamento identificado a partir dos quais o crédito condicionado
 * passa a `at_risk`.
 *
 * Heurística nossa, não prazo de norma: serve para ordenar a fila de cobrança do
 * escritório. 60 dias é o ponto em que uma compra a prazo normal já deveria ter
 * sido liquidada.
 */
export const DIAS_PARA_RISCO = 60;

export function classifyCredits(
  entradas: readonly CreditInput[],
  hoje: Date,
): CreditPosition[] {
  return entradas.map((entrada) => classificar(entrada, hoje));
}

function classificar(entrada: CreditInput, hoje: Date): CreditPosition {
  const base = {
    hasReformGroup: entrada.hasReformGroup,
    accessKey: entrada.accessKey,
    period: entrada.period,
    tax: entrada.tax,
    supplierCnpj: entrada.supplierCnpj,
    supplierName: entrada.supplierName,
    amountCents: entrada.amountCents,
  };

  const diasSemPagar = diasDesde(entrada.issuedAt, hoje);

  /**
   * Tributo do sistema antigo não é condicionado a liquidação nenhuma: o crédito
   * de ICMS, PIS e Cofins nasce do documento. Tratá-lo como condicionado
   * reportaria risco onde não há, e o escritório aprenderia a ignorar o alerta.
   */
  if (!ehTributoDaReforma(entrada.tax)) {
    return {
      ...base,
      state: 'expected',
      reason:
        `Crédito de ${entrada.tax.toUpperCase()} não depende da extinção do tributo da ` +
        'etapa anterior: nasce do documento.',
      unpaidDays: null,
    };
  }

  if (!entrada.hasReformGroup) {
    return {
      ...base,
      state: 'expected',
      reason:
        'O documento não traz o grupo IBS/CBS, então não há crédito da reforma ' +
        'destacado para condicionar.',
      unpaidDays: null,
    };
  }

  if (entrada.payment === undefined) {
    // Sem pagamento identificado: condicionado, e em risco quando envelhece.
    const emRisco = diasSemPagar !== null && diasSemPagar >= DIAS_PARA_RISCO;

    return {
      ...base,
      state: emRisco ? 'at_risk' : 'conditioned',
      reason: emRisco
        ? `Nenhum pagamento identificado no extrato há ${diasSemPagar} dias. Sem ` +
          'liquidação não há split payment, e sem split payment o tributo da etapa ' +
          'anterior não se extingue — o crédito não deve ser aproveitado ainda.'
        : 'Nenhum pagamento identificado no extrato. O crédito da reforma depende da ' +
          'extinção do tributo da etapa anterior, que sob split payment acontece na ' +
          'liquidação.',
      unpaidDays: diasSemPagar,
    };
  }

  /**
   * Pagamento identificado por hipótese fraca não libera nada.
   *
   * `amount_only` é "valor bate, data não", e `ambiguous` é "há mais de um
   * candidato". Promover qualquer um dos dois a crédito liberado seria aproveitar
   * crédito com base num casamento que o próprio módulo classificou como
   * incerto.
   */
  if (entrada.payment.confidence === 'ambiguous' || entrada.payment.confidence === 'amount_only') {
    return {
      ...base,
      state: 'conditioned',
      reason:
        `Há um pagamento candidato (${rotuloDeConfianca(entrada.payment.confidence)}), mas o ` +
        'casamento é incerto. Confirmar qual nota foi paga é o que permite tratar o ' +
        'crédito como liberado.',
      unpaidDays: diasSemPagar,
    };
  }

  /**
   * Pagamento identificado com boa confiança.
   *
   * Continua **condicionado**, e não liberado: nós pagamos, mas não temos como
   * observar que o tributo do fornecedor foi extinguido. Chamar de liberado
   * afirmaria algo sobre o recolhimento de terceiro que o sistema não sabe — e é
   * exatamente a afirmação que o Fisco depois glosaria.
   */
  return {
    ...base,
    state: 'conditioned',
    reason:
      `Pagamento identificado em ${entrada.payment.postedAt} ` +
      `(${rotuloDeConfianca(entrada.payment.confidence)}). Com a liquidação feita, a ` +
      'condição depende agora da extinção do tributo pelo fornecedor, que este sistema ' +
      'não tem como observar — não há fonte para o recolhimento de terceiro.',
    unpaidDays: null,
  };
}

/**
 * Agregação por fornecedor.
 *
 * É a pergunta que o produto responde e os concorrentes não: não "quanto de
 * crédito eu tenho", mas "de quem depende o crédito que eu tenho, e qual deles
 * está velho".
 */
export function aggregateBySupplier(posicoes: readonly CreditPosition[]): SupplierRisk[] {
  const porFornecedor = new Map<string, CreditPosition[]>();

  for (const posicao of posicoes) {
    const lista = porFornecedor.get(posicao.supplierCnpj) ?? [];
    lista.push(posicao);
    porFornecedor.set(posicao.supplierCnpj, lista);
  }

  const saida: SupplierRisk[] = [];

  for (const [cnpj, lista] of porFornecedor) {
    const somaDe = (estado: CreditState): number =>
      lista.filter((p) => p.state === estado).reduce((s, p) => s + p.amountCents, 0);

    const diasSemPagar = lista
      .map((p) => p.unpaidDays)
      .filter((d): d is number => d !== null);

    saida.push({
      supplierCnpj: cnpj,
      supplierName: lista.find((p) => p.supplierName !== null)?.supplierName ?? null,
      documents: new Set(lista.map((p) => p.accessKey)).size,
      creditExpectedCents: somaDe('expected'),
      creditConditionedCents: somaDe('conditioned'),
      creditReleasedCents: somaDe('released'),
      creditAtRiskCents: somaDe('at_risk'),
      oldestUnpaidDays: diasSemPagar.length === 0 ? null : Math.max(...diasSemPagar),
      emitsReformGroup: lista.some((p) => p.hasReformGroup),
    });
  }

  // Maior risco primeiro: é a ordem de trabalho do escritório.
  return saida.sort(
    (a, b) =>
      b.creditAtRiskCents - a.creditAtRiskCents ||
      b.creditConditionedCents - a.creditConditionedCents,
  );
}

const TRIBUTOS_DA_REFORMA = new Set(['ibs_uf', 'ibs_mun', 'cbs']);

function ehTributoDaReforma(tax: string): boolean {
  return TRIBUTOS_DA_REFORMA.has(tax);
}

function rotuloDeConfianca(confianca: MatchConfidence): string {
  const mapa: Record<MatchConfidence, string> = {
    exact: 'nota identificada no histórico do lançamento',
    amount_and_date: 'valor e data compatíveis',
    amount_only: 'valor compatível, data fora da janela',
    ambiguous: 'mais de um documento candidato',
  };
  return mapa[confianca];
}

function diasDesde(iso: string, hoje: Date): number | null {
  const emitida = Date.parse(iso);
  if (Number.isNaN(emitida)) {
    return null;
  }
  return Math.max(0, Math.floor((hoje.getTime() - emitida) / 86_400_000));
}
