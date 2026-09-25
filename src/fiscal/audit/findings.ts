import type { CriterionRef } from '../shared/evaluation-criterion.js';
import type { PeriodState } from '../shared/fiscal-vocabulary.js';
import type { RiskAssessment } from './risk-matrix.js';
import type { Verification, VerificationResult } from './verifications.js';

/**
 * Achado e estorno: onde o teste de comprovação vira efeito na apuração.
 *
 * A doutrina é direta — falhando uma verificação, o perito invalida e estorna o
 * lançamento, gerando saldo devedor para uma parte e credor para a outra. Aqui
 * as partes são o contribuinte e o Fisco, e estornar um crédito de entrada sai
 * do saldo credor do contribuinte e entra como devedor.
 *
 * **O sistema nunca estorna sozinho.** `propose` é puro e devolve a proposta
 * junto com os impedimentos; efetivar é ato de humano identificado. É a mesma
 * regra que o produto já vende: nenhuma IA altera um número fiscal sozinha.
 */

export const FINDING_STATUSES = [
  'open',
  /** O contador examinou e concorda. Só daqui sai estorno. */
  'accepted',
  /** Examinou e discorda, com justificativa. Não vira estorno, e fica no Book. */
  'rejected',
  /** Corrigido na origem: reclassificado, documento hábil obtido, reapropriado. */
  'resolved',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const IMPACT_SIDES = [
  'credito_a_estornar',
  'debito_a_constituir',
  'sem_efeito_no_saldo',
] as const;
export type ImpactSide = (typeof IMPACT_SIDES)[number];

export interface AuditFinding {
  /**
   * Determinístico: `${procedureId}:${period}:${subject}`.
   *
   * Reexecutar a trilha produz os mesmos identificadores, então a reexecução
   * **substitui** em vez de acumular — e permite preservar o `accepted` de um
   * achado já revisado por humano, em vez de rebaixá-lo a `open` a cada rodada.
   * É o mesmo raciocínio do índice único do calendário de prazos.
   */
  findingId: string;
  procedureId: string;
  period: string;
  /** Chave de acesso, id de item, tributo — o que o achado aponta. */
  subject: string;
  /** As cinco, com o resultado de cada. Ordem = `VERIFICATIONS`. */
  verifications: readonly VerificationResult[];
  /** Derivado. Vazio significa que isto não é achado. */
  failed: readonly Verification[];
  /** Inteiro, em centavos. */
  impactCents: number;
  impactSide: ImpactSide;
  risk: RiskAssessment;
  criterion: CriterionRef | null;
  /**
   * `false` quando o critério não está conferido. O achado existe, aparece e
   * **não afirma** — a tela o mostra com ressalva em vez de escondê-lo.
   */
  assertable: boolean;
  status: FindingStatus;
}

// ------------------------------------------------------------------ estorno

export const REVERSAL_BLOCKERS = [
  'criterio_nao_conferido',
  'teste_inconclusivo',
  /** INV-001: em competência confirmada o caminho é a retificação, não o estorno. */
  'competencia_confirmada',
  'achado_nao_aceito_pelo_contador',
  'sem_efeito_no_saldo',
  'estorno_ja_aplicado',
] as const;
export type ReversalBlocker = (typeof REVERSAL_BLOCKERS)[number];

export interface ReversalProposal {
  findingId: string;
  subject: string;
  period: string;
  /** Inteiros, nunca negativos. */
  creditReversedCents: number;
  debitConstitutedCents: number;
  /** Positivo = mais imposto a pagar. Soma, não compensação cruzada. */
  netEffectCents: number;
  basis: {
    /** A primeira falha na ordem do teste. É ela que fundamenta o estorno. */
    verification: Verification | null;
    criterion: CriterionRef | null;
  };
  /** Vazio = pode aplicar. */
  blockers: readonly ReversalBlocker[];
}

export function propose(input: {
  finding: AuditFinding;
  periodState: PeriodState;
  alreadyReversed: boolean;
}): ReversalProposal {
  const { finding } = input;
  const blockers: ReversalBlocker[] = [];

  if (!finding.assertable) {
    blockers.push('criterio_nao_conferido');
  }
  if (finding.failed.length === 0) {
    blockers.push('teste_inconclusivo');
  }
  if (input.periodState === 'confirmed') {
    blockers.push('competencia_confirmada');
  }
  if (finding.status !== 'accepted') {
    blockers.push('achado_nao_aceito_pelo_contador');
  }
  if (finding.impactSide === 'sem_efeito_no_saldo') {
    blockers.push('sem_efeito_no_saldo');
  }
  if (input.alreadyReversed) {
    blockers.push('estorno_ja_aplicado');
  }

  const credito = finding.impactSide === 'credito_a_estornar' ? finding.impactCents : 0;
  const debito = finding.impactSide === 'debito_a_constituir' ? finding.impactCents : 0;

  return {
    findingId: finding.findingId,
    subject: finding.subject,
    period: finding.period,
    creditReversedCents: credito,
    debitConstitutedCents: debito,
    // Os dois somam porque apontam para o mesmo lado: estornar crédito e
    // constituir débito aumentam o imposto devido. Compensá-los esconderia
    // metade do efeito.
    netEffectCents: credito + debito,
    basis: {
      verification: finding.failed[0] ?? null,
      criterion: finding.criterion,
    },
    blockers,
  };
}

export function canApply(proposal: ReversalProposal): boolean {
  return proposal.blockers.length === 0;
}
