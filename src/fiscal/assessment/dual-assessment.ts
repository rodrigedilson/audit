import type { Regime } from '../shared/fiscal-vocabulary.js';

/**
 * Apuração dual: tributos atuais e IBS/CBS lado a lado, documento por documento
 * e item por item — o diferencial #2 do briefing.
 *
 * ## O que é calculado e o que é recusado
 *
 * **Débito** e **crédito potencial** saem dos valores **destacados nos próprios
 * documentos**. Não dependem de alíquota nenhuma: são a soma do que o emitente
 * declarou. É a "Base Espelho" — 100% dos documentos, zero amostragem — e está
 * disponível hoje, sem depender de norma publicada.
 *
 * **O valor devido não é calculado sem regra publicada.** Decidir se um crédito
 * é aproveitável depende do regime e da norma vigente, e essa é exatamente a
 * parte que o briefing marca como não conferida em texto oficial. Então
 * `creditable` e `due` vêm `null` com o motivo, em vez de um número plausível.
 *
 * Um número fiscal errado é pior do que um número ausente: o ausente o contador
 * investiga, o errado ele entrega.
 */

export type LegacyTax = 'icms' | 'ipi' | 'pis' | 'cofins';
export type ReformTax = 'ibs_uf' | 'ibs_mun' | 'cbs';
export type AnyTax = LegacyTax | ReformTax;

export interface TaxAmount {
  cst?: string;
  baseCents: number;
  rate: number;
  amountCents: number;
}

export interface AssessmentItem {
  line: number;
  code: string;
  ncm: string;
  totalCents: number;
  legacy: Partial<Record<LegacyTax, TaxAmount>>;
  reform?: {
    cst?: string;
    cclasstrib?: string;
    ibs_uf?: TaxAmount;
    ibs_mun?: TaxAmount;
    cbs?: TaxAmount;
  };
}

export interface AssessmentDocument {
  accessKey: string;
  direction: 'inbound' | 'outbound';
  items: readonly AssessmentItem[];
}

/**
 * Regra de creditamento por regime e tributo, vinda de `tax_rules` com vigência.
 * Ausente significa "não publicada", não "não credita".
 */
export interface CreditRule {
  tax: AnyTax;
  /** Fração do crédito destacado que é aproveitável, de 0 a 1. */
  creditableShare: number;
  ruleId: string;
}

export interface RuleSet {
  /** Vazio quando nenhuma regra foi publicada para a competência. */
  creditRules: ReadonlyMap<AnyTax, CreditRule>;
}

export interface TaxTotals {
  /** Soma do tributo destacado nas saídas. Sempre calculável. */
  debitsCents: number;
  /** Soma do tributo destacado nas entradas, antes do juízo de creditamento. */
  potentialCreditsCents: number;
  /** Crédito aproveitável. `null` quando a regra não está publicada. */
  creditableCents: number | null;
  /** `debits - creditable`. `null` quando o crédito não é determinável. */
  dueCents: number | null;
  /** Id da regra aplicada, para a memória de cálculo. */
  ruleId?: string;
}

/** Uma linha da memória de cálculo. É o que dá ao contador o que defender. */
export interface TraceLine {
  accessKey: string;
  line: number;
  itemCode: string;
  ncm: string;
  tax: AnyTax;
  direction: 'inbound' | 'outbound';
  cst?: string;
  baseCents: number;
  rate: number;
  amountCents: number;
  /** De onde o valor veio. Hoje sempre do documento. */
  origin: 'documento';
}

export interface NotComputable {
  scope: 'tributo' | 'item';
  subject: string;
  reason: 'rule_not_published' | 'missing_reform_group';
  message: string;
}

export interface AssessmentResult {
  period: string;
  regime: Regime;
  legacy: Record<LegacyTax, TaxTotals>;
  reform: Record<ReformTax, TaxTotals>;
  trace: TraceLine[];
  notComputable: NotComputable[];
  documentsConsidered: number;
  itemsConsidered: number;
  /** Prontidão para a reforma: itens que já trazem o grupo UB. */
  coverage: { itemsWithReformGroup: number; itemsTotal: number };
}

export interface AssessmentInput {
  period: string;
  regime: Regime;
  documents: readonly AssessmentDocument[];
  rules: RuleSet;
}

const LEGACY_TAXES: readonly LegacyTax[] = ['icms', 'ipi', 'pis', 'cofins'];
const REFORM_TAXES: readonly ReformTax[] = ['ibs_uf', 'ibs_mun', 'cbs'];

export function emptyRuleSet(): RuleSet {
  return { creditRules: new Map() };
}

export function project(input: AssessmentInput): AssessmentResult {
  const legacy = zeroTotals(LEGACY_TAXES);
  const reform = zeroTotals(REFORM_TAXES);
  const trace: TraceLine[] = [];
  const notComputable: NotComputable[] = [];

  let itemsConsiderados = 0;
  let itensComReforma = 0;

  for (const documento of input.documents) {
    for (const item of documento.items) {
      itemsConsiderados += 1;

      for (const tributo of LEGACY_TAXES) {
        const valor = item.legacy[tributo];
        if (valor) {
          acumular(legacy[tributo], documento.direction, valor.amountCents);
          trace.push(linhaDeTrilha(documento, item, tributo, valor));
        }
      }

      if (item.reform) {
        itensComReforma += 1;
        for (const tributo of REFORM_TAXES) {
          const valor = item.reform[tributo];
          if (valor) {
            acumular(reform[tributo], documento.direction, valor.amountCents);
            trace.push(linhaDeTrilha(documento, item, tributo, valor));
          }
        }
      } else {
        notComputable.push({
          scope: 'item',
          subject: `${documento.accessKey}#${item.line}`,
          reason: 'missing_reform_group',
          message:
            `Item ${item.code} não traz o grupo IBS/CBS: o lado novo da apuração ` +
            'não pode ser conferido contra o documento.',
        });
      }
    }
  }

  // A ordem da trilha é estável para que a memória de cálculo saia igual entre
  // duas execuções — ela entra no Book, que carrega o hash da projeção.
  trace.sort(ordenarTrilha);

  aplicarRegras(legacy, input.rules, notComputable);
  aplicarRegras(reform, input.rules, notComputable);

  return {
    period: input.period,
    regime: input.regime,
    legacy,
    reform,
    trace,
    notComputable,
    documentsConsidered: input.documents.length,
    itemsConsidered: itemsConsiderados,
    coverage: { itemsWithReformGroup: itensComReforma, itemsTotal: itemsConsiderados },
  };
}

/**
 * O juízo de creditamento. Sem regra publicada para o tributo, `creditable` e
 * `due` ficam `null` e o motivo entra em `notComputable` — nunca um número
 * assumido.
 */
function aplicarRegras<T extends AnyTax>(
  totais: Record<T, TaxTotals>,
  rules: RuleSet,
  notComputable: NotComputable[],
): void {
  for (const [tributo, total] of Object.entries(totais) as [T, TaxTotals][]) {
    const regra = rules.creditRules.get(tributo);

    if (!regra) {
      // Tributo sem movimento não precisa de regra: não há o que decidir.
      if (total.debitsCents === 0 && total.potentialCreditsCents === 0) {
        total.creditableCents = 0;
        total.dueCents = 0;
        continue;
      }

      notComputable.push({
        scope: 'tributo',
        subject: tributo,
        reason: 'rule_not_published',
        message:
          `Regra de creditamento de ${tributo.toUpperCase()} não publicada para a ` +
          'competência: débito e crédito potencial estão somados, mas o valor devido ' +
          'não é determinável.',
      });
      continue;
    }

    // Arredonda o crédito aproveitável em centavos inteiros: fração de centavo
    // acumulada em milhares de itens aparece no total da guia.
    total.creditableCents = Math.round(total.potentialCreditsCents * regra.creditableShare);
    total.dueCents = total.debitsCents - total.creditableCents;
    total.ruleId = regra.ruleId;
  }
}

function acumular(total: TaxTotals, direction: 'inbound' | 'outbound', cents: number): void {
  if (direction === 'outbound') {
    total.debitsCents += cents;
  } else {
    total.potentialCreditsCents += cents;
  }
}

function zeroTotals<T extends string>(tributos: readonly T[]): Record<T, TaxTotals> {
  return Object.fromEntries(
    tributos.map((t) => [
      t,
      { debitsCents: 0, potentialCreditsCents: 0, creditableCents: null, dueCents: null },
    ]),
  ) as Record<T, TaxTotals>;
}

function linhaDeTrilha(
  documento: AssessmentDocument,
  item: AssessmentItem,
  tributo: AnyTax,
  valor: TaxAmount,
): TraceLine {
  return {
    accessKey: documento.accessKey,
    line: item.line,
    itemCode: item.code,
    ncm: item.ncm,
    tax: tributo,
    direction: documento.direction,
    ...(valor.cst === undefined ? {} : { cst: valor.cst }),
    baseCents: valor.baseCents,
    rate: valor.rate,
    amountCents: valor.amountCents,
    origin: 'documento',
  };
}

function ordenarTrilha(a: TraceLine, b: TraceLine): number {
  return (
    a.accessKey.localeCompare(b.accessKey) || a.line - b.line || a.tax.localeCompare(b.tax)
  );
}

/** Soma dos valores devidos determináveis. `null` se algum tributo não é determinável. */
export function totalDue(result: AssessmentResult): number | null {
  const todos = [...Object.values(result.legacy), ...Object.values(result.reform)];

  if (todos.some((t) => t.dueCents === null)) {
    return null;
  }
  return todos.reduce((soma, t) => soma + (t.dueCents ?? 0), 0);
}
