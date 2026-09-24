import type { PeriodState } from '../shared/fiscal-vocabulary.js';
import type { CriterionRef } from '../shared/evaluation-criterion.js';

/**
 * Trilhas de auditoria: agrupam as inconsistências das 7 camadas em checagens
 * nomeadas, com severidade e valor em risco — o conteúdo do Book de fechamento.
 *
 * Cada trilha corresponde a uma checagem que o sistema **executa de fato**,
 * amarrada a uma camada do pipeline e a um motivo que existe no código. O
 * briefing cita o "Book de Auditorias (15+ verificações que a RFB faz)" do
 * concorrente como referência, mas nomear uma trilha que o produto não verifica
 * seria vender conferência que não acontece.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type TrailStatus = 'passed' | 'warning' | 'failed' | 'not_applicable';
export type TaxScope = 'legacy' | 'reform' | 'both' | 'none';
export type TrailSource =
  | 'output_rejected'
  | 'item_classification'
  | 'assessment'
  | 'period_state';

export interface TrailDefinition {
  trailId: string;
  name: string;
  description: string;
  layer: number | null;
  defaultSeverity: Severity;
  taxScope: TaxScope;
  source: TrailSource;
  /** Motivos (ou estados, no caso de `period_state`) que a trilha reconhece. */
  matches: readonly string[];
}

export interface TrailIssue {
  /** Chave de acesso, id de item, tributo — o que a inconsistência aponta. */
  subject: string;
  message: string;
  severity: Severity;
  layer?: number;
  /**
   * A norma ou invariante contra a qual isto foi julgado. É o que transforma a
   * linha do Book de "o sistema recusou" em "recusou conforme X" — a diferença
   * entre relatório e prova.
   */
  criterion?: CriterionRef;
  /** Notas emitidas afetadas, quando a origem sabe. */
  documentsAffected?: number;
  amountAtStakeCents?: number;
}

export interface TrailResult {
  trailId: string;
  name: string;
  description: string;
  layer: number | null;
  severity: Severity;
  taxScope: TaxScope;
  status: TrailStatus;
  issuesCount: number;
  amountAtStakeCents: number;
  documentsAffected: number;
  issues: TrailIssue[];
}

export interface RejectionRecord {
  reason: string;
  layer: number;
  details: string;
  subject: string;
  eventSeq: number;
  /** Contra o quê se julgou. Ausente em rejeição de forma da requisição. */
  criterion?: CriterionRef;
}

export interface ClassificationIssueRecord {
  itemId: string;
  reason: string;
  severity: Severity;
  message: string;
  documentsAffected: number;
  amountAtStakeCents: number;
}

export interface AssessmentIssueRecord {
  reason: string;
  subject: string;
  message: string;
}

export interface TrailInput {
  definitions: readonly TrailDefinition[];
  rejections: readonly RejectionRecord[];
  classificationIssues: readonly ClassificationIssueRecord[];
  assessmentIssues: readonly AssessmentIssueRecord[];
  periodState: PeriodState;
  /** Quando `false`, as trilhas de código ficam `not_applicable`: não houve conferência. */
  referenceTablesLoaded: boolean;
}

export interface TrailsSummary {
  passed: number;
  warning: number;
  failed: number;
  not_applicable: number;
  amountAtStakeCents: number;
}

/**
 * Limite de inconsistências por trilha no resultado.
 *
 * Um CNPJ com 5.000 itens errados geraria um Book de centenas de páginas que
 * ninguém lê. A contagem total continua exata; o detalhe é amostrado e o Book
 * remete ao drill-down da tela.
 */
export const MAX_ISSUES_POR_TRILHA = 25;

export function runTrails(input: TrailInput): TrailResult[] {
  return input.definitions
    .map((definicao) => avaliar(definicao, input))
    .sort(ordenarPorGravidade);
}

export function summarize(resultados: readonly TrailResult[]): TrailsSummary {
  return {
    passed: resultados.filter((r) => r.status === 'passed').length,
    warning: resultados.filter((r) => r.status === 'warning').length,
    failed: resultados.filter((r) => r.status === 'failed').length,
    not_applicable: resultados.filter((r) => r.status === 'not_applicable').length,
    amountAtStakeCents: resultados.reduce((soma, r) => soma + r.amountAtStakeCents, 0),
  };
}

function avaliar(definicao: TrailDefinition, input: TrailInput): TrailResult {
  const issues = coletar(definicao, input);

  const base = {
    trailId: definicao.trailId,
    name: definicao.name,
    description: definicao.description,
    layer: definicao.layer,
    severity: definicao.defaultSeverity,
    taxScope: definicao.taxScope,
  };

  /**
   * Trilha de código sem tabela oficial carregada não é "passou": é "não
   * conferido". Reportar `passed` daria ao escritório a impressão de que o
   * cadastro foi validado quando nada foi comparado.
   */
  if (
    definicao.source === 'item_classification' &&
    definicao.trailId !== 'codigo_nao_verificado' &&
    !input.referenceTablesLoaded
  ) {
    return {
      ...base,
      status: 'not_applicable',
      issuesCount: 0,
      amountAtStakeCents: 0,
      documentsAffected: 0,
      issues: [],
    };
  }

  const amountAtStakeCents = issues.reduce((soma, i) => soma + (i.amountAtStakeCents ?? 0), 0);
  const documentsAffected = issues.reduce((soma, i) => soma + (i.documentsAffected ?? 0), 0);

  return {
    ...base,
    status: derivarStatus(definicao, issues.length),
    issuesCount: issues.length,
    amountAtStakeCents,
    documentsAffected,
    issues: issues.slice(0, MAX_ISSUES_POR_TRILHA),
  };
}

function derivarStatus(definicao: TrailDefinition, quantidade: number): TrailStatus {
  if (quantidade === 0) {
    return 'passed';
  }
  // `high` e `critical` reprovam: são as que impedem a apuração de fechar ou
  // fazem a nota ser punida na apuração.
  return definicao.defaultSeverity === 'critical' || definicao.defaultSeverity === 'high'
    ? 'failed'
    : 'warning';
}

function coletar(definicao: TrailDefinition, input: TrailInput): TrailIssue[] {
  switch (definicao.source) {
    case 'output_rejected':
      return input.rejections
        .filter((r) => casa(definicao, r.reason) && camadaCompativel(definicao, r.layer))
        .map((r) => ({
          subject: r.subject,
          message: r.details,
          severity: definicao.defaultSeverity,
          layer: r.layer,
          ...(r.criterion === undefined ? {} : { criterion: r.criterion }),
        }));

    case 'item_classification':
      return input.classificationIssues
        .filter((i) => casa(definicao, i.reason))
        .map((i) => ({
          subject: i.itemId,
          message: i.message,
          severity: i.severity,
          ...(definicao.layer === null ? {} : { layer: definicao.layer }),
          documentsAffected: i.documentsAffected,
          amountAtStakeCents: i.amountAtStakeCents,
        }));

    case 'assessment':
      return input.assessmentIssues
        .filter((i) => casa(definicao, i.reason))
        .map((i) => ({
          subject: i.subject,
          message: i.message,
          severity: definicao.defaultSeverity,
        }));

    case 'period_state':
      return casa(definicao, input.periodState)
        ? [
            {
              subject: 'competência',
              message:
                `A competência está em '${input.periodState}' e não foi confirmada. ` +
                'Sem confirmação não há hash de fechamento.',
              severity: definicao.defaultSeverity,
            },
          ]
        : [];

    default:
      return [];
  }
}

function casa(definicao: TrailDefinition, valor: string): boolean {
  return definicao.matches.includes(valor);
}

/**
 * Duas trilhas compartilham o motivo `schema_violation` — XML malformado
 * (camada 1) e chave inconsistente (camada 2). A camada é o que as separa, e sem
 * isso a mesma rejeição apareceria nas duas.
 */
function camadaCompativel(definicao: TrailDefinition, layer: number): boolean {
  return definicao.layer === null || definicao.layer === layer;
}

function ordenarPorGravidade(a: TrailResult, b: TrailResult): number {
  const peso: Record<TrailStatus, number> = {
    failed: 0,
    warning: 1,
    not_applicable: 2,
    passed: 3,
  };
  const pesoSeveridade: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return (
    peso[a.status] - peso[b.status] ||
    pesoSeveridade[a.severity] - pesoSeveridade[b.severity] ||
    b.amountAtStakeCents - a.amountAtStakeCents ||
    a.trailId.localeCompare(b.trailId)
  );
}
