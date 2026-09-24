import type { EvaluationCriterion } from '../shared/evaluation-criterion.js';
import { canAssert, toRef } from '../shared/evaluation-criterion.js';
import type { CodeTables } from '../catalog/code-validation.js';
import type { AuditProcedure, ExaminableSubject, SamplingPlan } from './audit-procedure.js';
import type { AuditFinding, FindingStatus, ImpactSide } from './findings.js';
import { assess } from './risk-matrix.js';
import { conclude, failedVerifications, VERIFICATIONS } from './verifications.js';
import type { VerificationResult } from './verifications.js';
import { VERIFIERS, type VerifierContext } from './verifiers.js';

/**
 * Execução de uma trilha: puro e determinístico para a mesma entrada.
 *
 * Nada de `Date.now()` nem de identificador sorteado aqui dentro. O achado tem
 * identificador derivado do que ele é, e a hora vem do evento — é o que permite
 * reexecutar a trilha e obter exatamente o mesmo resultado, que por sua vez é o
 * que permite **substituir** a execução anterior em vez de acumular.
 */

export const EXECUTION_STATUSES = [
  'completed',
  /**
   * Rodou e não concluiu: critério não conferido, tabela de referência ausente,
   * verificador inexistente. **Não** é `completed` com zero achados — essa
   * confusão é a que faria a tela dizer "limpo" onde nada foi conferido.
   */
  'inconclusive',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ExecutionInput {
  procedure: AuditProcedure;
  /** `null` quando a trilha aponta para um critério que não está carregado. */
  criterion: EvaluationCriterion | null;
  period: string;
  /** População já materializada, na ordem do banco. */
  population: readonly ExaminableSubject[];
  /** Débito total da competência: base do impacto relativo. */
  periodBaseCents: number;
  tables: CodeTables;
  tablesLoaded: boolean;
  cnpj: string;
  /** Data de referência do exame, injetada. */
  today: string;
  /** Achados anteriores desta trilha e competência, para preservar revisão humana. */
  previousFindings: readonly Pick<AuditFinding, 'findingId' | 'status'>[];
}

export interface ExecutionOutput {
  procedureId: string;
  period: string;
  status: ExecutionStatus;
  /** Obrigatório quando `inconclusive`. */
  inconclusiveReason: string | null;
  populationSize: number;
  examinedCount: number;
  sampling: SamplingPlan;
  criterionVerified: boolean;
  findings: readonly AuditFinding[];
  /** Achados anteriores cujo sujeito agora passa nas cinco. */
  resolvedFindingIds: readonly string[];
  totalImpactCents: number;
}

/** `trilha:competência:sujeito` — determinístico, para reexecutar substituir. */
export function findingId(procedureId: string, period: string, subject: string): string {
  return `${procedureId}:${period}:${subject}`;
}

/**
 * O que o achado faz com o saldo.
 *
 * `propor_estorno` sobre crédito retira do saldo credor; sobre o resto, o
 * achado vale como alerta e não mexe em número — inventar um débito a partir de
 * uma trilha de documento seria apurar por conta própria.
 */
function ladoDoImpacto(procedure: AuditProcedure, subject: ExaminableSubject): ImpactSide {
  if (procedure.reversalPolicy === 'somente_achado') {
    return 'sem_efeito_no_saldo';
  }
  return subject.creditState === null ? 'sem_efeito_no_saldo' : 'credito_a_estornar';
}

function examinar(
  subject: ExaminableSubject,
  procedure: AuditProcedure,
  context: VerifierContext,
): VerificationResult[] {
  return procedure.verifications.map((v) => {
    const verifier = VERIFIERS[v];

    if (verifier === undefined) {
      // Verificador ausente é estado declarado, não lacuna escondida: a
      // verificação aparece no relatório dizendo que não rodou.
      return {
        verification: v,
        outcome: 'not_verified' as const,
        rationale: 'Esta verificação ainda não tem verificador implementado.',
        compared: [],
        criterion: toRef(context.criterion),
      };
    }

    return verifier(subject, context);
  });
}

export function execute(input: ExecutionInput): ExecutionOutput {
  const { procedure, criterion, period, population } = input;
  const base = {
    procedureId: procedure.procedureId,
    period,
    populationSize: population.length,
    sampling: procedure.sampling,
  };

  if (criterion === null) {
    return {
      ...base,
      status: 'inconclusive',
      inconclusiveReason:
        `O critério '${procedure.criterionId}' não está carregado; sem parâmetro ` +
        'de comparação o teste não conclui.',
      examinedCount: 0,
      criterionVerified: false,
      findings: [],
      resolvedFindingIds: [],
      totalImpactCents: 0,
    };
  }

  const podeAfirmar = canAssert(criterion, input.today);
  const context: VerifierContext = {
    cnpj: input.cnpj,
    criterion,
    tables: input.tables,
    tablesLoaded: input.tablesLoaded,
  };

  const anteriores = new Map(input.previousFindings.map((f) => [f.findingId, f.status]));
  const achados: AuditFinding[] = [];
  const resolvidos: string[] = [];
  let inconclusivos = 0;

  for (const subject of population) {
    const verifications = examinar(subject, procedure, context);
    const veredito = conclude(verifications);
    const id = findingId(procedure.procedureId, period, subject.subject);

    if (veredito === 'confiavel') {
      // Sujeito que antes tinha achado e agora passa nas cinco está resolvido
      // na origem — reclassificado, documento obtido, reapropriado.
      if (anteriores.has(id)) {
        resolvidos.push(id);
      }
      continue;
    }

    if (veredito === 'inconclusivo') {
      inconclusivos += 1;
      continue;
    }

    const failed = failedVerifications(verifications);
    const impactSide = ladoDoImpacto(procedure, subject);
    const impactCents = impactSide === 'sem_efeito_no_saldo' ? 0 : subject.amountCents;

    achados.push({
      findingId: id,
      procedureId: procedure.procedureId,
      period,
      subject: subject.subject,
      verifications,
      failed,
      impactCents,
      impactSide,
      // Recalculada abaixo com a frequência da população inteira: a
      // probabilidade é do conjunto, não do sujeito.
      risk: assess({
        failures: 1,
        examined: 1,
        amountAtStakeCents: impactCents,
        periodBaseCents: input.periodBaseCents,
      }),
      criterion: toRef(criterion),
      assertable: podeAfirmar,
      // Preserva a revisão humana: rebaixar a `open` a cada reexecução faria o
      // contador revisar de novo o que já revisou.
      status: (anteriores.get(id) ?? 'open') as FindingStatus,
    });
  }

  const examined = population.length;
  const comRisco = achados.map((a) => ({
    ...a,
    risk: assess({
      failures: achados.length,
      examined,
      amountAtStakeCents: a.impactCents,
      periodBaseCents: input.periodBaseCents,
    }),
  }));

  const status: ExecutionStatus =
    !podeAfirmar || inconclusivos > 0 ? 'inconclusive' : 'completed';

  return {
    ...base,
    status,
    inconclusiveReason:
      status === 'completed'
        ? null
        : !podeAfirmar
          ? `O critério '${criterion.criterionId}' não foi conferido em texto ` +
            'oficial: os achados existem e não afirmam.'
          : `${inconclusivos} de ${examined} sujeito(s) não puderam ser ` +
            'inteiramente verificados.',
    examinedCount: examined,
    criterionVerified: criterion.verified,
    findings: comRisco,
    resolvedFindingIds: resolvidos,
    totalImpactCents: comRisco.reduce((soma, a) => soma + a.impactCents, 0),
  };
}

/** As cinco, para a trilha que quiser o teste inteiro. */
export const TODAS_AS_VERIFICACOES = VERIFICATIONS;
