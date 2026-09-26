import type pg from 'pg';

import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import { emptyCodeTables, type CodeTables } from '../catalog/code-validation.js';
import type { EvaluationCriterion } from '../shared/evaluation-criterion.js';
import type { AuditProcedure, ExaminableSubject, PopulationKind } from './audit-procedure.js';
import { execute, type ExecutionOutput } from './execution.js';
import type { AuditFinding, FindingStatus } from './findings.js';
import { PopulationRepository } from './population.js';
import { TRILHAS_INICIAIS } from './trilhas-iniciais.js';

/**
 * Leitura e escrita da auditoria contínua.
 *
 * O serviço materializa a população, chama o executor puro e persiste o
 * resultado. Ele **não decide** nada sobre o exame: essa é toda a razão de
 * `execution.ts` ser puro e determinístico, e é o que permite que o mesmo
 * resultado seja reproduzido a partir do log.
 */

export class AuditService {
  private readonly populations: PopulationRepository;

  constructor(private readonly pool: pg.Pool) {
    this.populations = new PopulationRepository(pool);
  }

  /** As trilhas que o produto sabe executar. Catálogo, não estado do cliente. */
  procedures(): readonly AuditProcedure[] {
    return TRILHAS_INICIAIS;
  }

  async criterion(criterionId: string): Promise<EvaluationCriterion | null> {
    const { rows } = await this.pool.query<{
      criterion_id: string;
      kind: string;
      citation: string;
      parameter: string;
      valid_from: Date | null;
      valid_to: Date | null;
      source_ref: string | null;
      verified: boolean;
    }>(
      `select criterion_id, kind, citation, parameter, valid_from, valid_to,
              source_ref, verified
         from evaluation_criteria
        where criterion_id = $1`,
      [criterionId],
    );

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

    return {
      criterionId: row.criterion_id,
      kind: row.kind as EvaluationCriterion['kind'],
      citation: row.citation,
      parameter: row.parameter,
      validFrom: iso(row.valid_from),
      validTo: iso(row.valid_to),
      sourceRef: row.source_ref,
      verified: row.verified,
    };
  }

  /**
   * População da trilha, pelo tipo que ela declara.
   *
   * Antes toda trilha recebia créditos de entrada, inclusive a que declara
   * itens do catálogo — examinava-se outra coisa sob o nome pedido.
   */
  async population(
    scope: EventScope,
    period: string,
    kind: PopulationKind = 'creditos_de_entrada',
    tables: CodeTables = emptyCodeTables(),
  ): Promise<ExaminableSubject[]> {
    return this.populations.load(scope, period, kind, tables);
  }

  /** Débito da competência: base do impacto relativo. Zero quando não apurada. */
  async periodBaseCents(scope: EventScope, period: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string | null }>(
      `select sum(amount_cents)::text as total
         from assessment_lines
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    return Number(rows[0]?.total ?? 0);
  }

  async previousFindings(
    scope: EventScope,
    period: string,
    procedureId: string,
  ): Promise<Pick<AuditFinding, 'findingId' | 'status'>[]> {
    const { rows } = await this.pool.query<{ finding_id: string; status: string }>(
      `select finding_id, status
         from audit_findings
        where tenant_id = $1::uuid and cnpj = $2::char(14)
          and period = $3::char(7) and procedure_id = $4`,
      [scope.tenantId, scope.cnpj, period, procedureId],
    );

    return rows.map((r) => ({ findingId: r.finding_id, status: r.status as FindingStatus }));
  }

  /**
   * Executa uma trilha sem persistir. A persistência é do chamador, após o evento.
   *
   * As tabelas vêm do chamador para serem carregadas uma vez por requisição, e
   * não uma vez por trilha. O default vazio existe para quem só quer ver o
   * exame sem referência — e aí a verificação 3 sai `not_verified`, como deve.
   */
  async run(
    scope: EventScope,
    procedure: AuditProcedure,
    period: string,
    today: string,
    tables: CodeTables = emptyCodeTables(),
  ): Promise<ExecutionOutput> {
    const [criterion, population, base, previous] = await Promise.all([
      this.criterion(procedure.criterionId),
      this.population(scope, period, procedure.population, tables),
      this.periodBaseCents(scope, period),
      this.previousFindings(scope, period, procedure.procedureId),
    ]);

    return execute({
      procedure,
      criterion,
      period,
      population,
      periodBaseCents: base,
      tables,
      // NCM é a tabela que a verificação 3 mais usa; vazia significa que nada
      // foi carregado, e a verificação sai `not_verified` em vez de `pass`.
      tablesLoaded: tables.ncm.size > 0,
      cnpj: scope.cnpj,
      today,
      previousFindings: previous,
    });
  }

  /**
   * Grava execução e achados na mesma transação.
   *
   * Reexecutar **substitui**: o identificador do achado é determinístico, e o
   * `on conflict` preserva a revisão humana já feita — rebaixar a `open` toda
   * rodada faria o contador revisar de novo o que já revisou.
   */
  async persist(
    scope: EventScope,
    output: ExecutionOutput,
    procedure: Pick<AuditProcedure, 'criterionId' | 'population'>,
    eventSeq: number,
    executedBy: string,
  ): Promise<string> {
    const { criterionId } = procedure;

    const client = await this.pool.connect();

    try {
      await client.query('begin');

      const { rows } = await client.query<{ id: string }>(
        `insert into audit_executions
           (tenant_id, cnpj, period, procedure_id, status, inconclusive_reason,
            population_size, examined_count, findings_count, total_impact_cents,
            sampling_technique, sampling_size, sampling_seed,
            criterion_id, criterion_verified, event_seq, executed_by)
         values ($1::uuid, $2::char(14), $3::char(7), $4, $5, $6,
                 $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::uuid)
         returning id`,
        [
          scope.tenantId,
          scope.cnpj,
          output.period,
          output.procedureId,
          output.status,
          output.inconclusiveReason,
          output.populationSize,
          output.examinedCount,
          output.findings.length,
          output.totalImpactCents,
          output.sampling.technique,
          output.sampling.size,
          output.sampling.seed,
          criterionId,
          output.criterionVerified,
          eventSeq,
          executedBy,
        ],
      );

      const executionId = rows[0]!.id;

      for (const f of output.findings) {
        await client.query(
          `insert into audit_findings
             (tenant_id, cnpj, finding_id, execution_id, procedure_id, period,
              subject, subject_kind, verifications, failed, impact_cents,
              impact_side, likelihood, impact, risk_score, severity,
              observed_failures, observed_examined, criterion_id, assertable,
              status, event_seq)
           values ($1::uuid, $2::char(14), $3, $4::uuid, $5, $6::char(7),
                   $7, $8, $9::jsonb, $10::text[], $11, $12, $13, $14, $15, $16,
                   $17, $18, $19, $20, $21, $22)
           on conflict (tenant_id, cnpj, finding_id) do update set
             execution_id = excluded.execution_id,
             verifications = excluded.verifications,
             failed = excluded.failed,
             impact_cents = excluded.impact_cents,
             impact_side = excluded.impact_side,
             likelihood = excluded.likelihood,
             impact = excluded.impact,
             risk_score = excluded.risk_score,
             severity = excluded.severity,
             observed_failures = excluded.observed_failures,
             observed_examined = excluded.observed_examined,
             assertable = excluded.assertable,
             event_seq = excluded.event_seq`,
          [
            scope.tenantId,
            scope.cnpj,
            f.findingId,
            executionId,
            f.procedureId,
            f.period,
            f.subject,
            procedure.population,
            JSON.stringify(f.verifications),
            f.failed,
            f.impactCents,
            f.impactSide,
            f.risk.likelihood,
            f.risk.impact,
            f.risk.score,
            f.risk.severity,
            f.risk.observed.failures,
            f.risk.observed.examined,
            criterionId,
            f.assertable,
            f.status,
            eventSeq,
          ],
        );
      }

      /** Corrigido na origem: sai da fila sem apagar o histórico. */
      if (output.resolvedFindingIds.length > 0) {
        await client.query(
          `update audit_findings set status = 'resolved'
            where tenant_id = $1::uuid and cnpj = $2::char(14)
              and finding_id = any($3::text[]) and status <> 'resolved'`,
          [scope.tenantId, scope.cnpj, output.resolvedFindingIds],
        );
      }

      await client.query('commit');
      return executionId;
    } catch (erro) {
      await client.query('rollback');
      throw erro;
    } finally {
      client.release();
    }
  }

  async finding(scope: EventScope, findingId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `select finding_id, period, subject, failed, impact_cents, impact_side,
              severity, criterion_id, assertable, status
         from audit_findings
        where tenant_id = $1::uuid and cnpj = $2::char(14) and finding_id = $3`,
      [scope.tenantId, scope.cnpj, findingId],
    );

    return rows[0] ?? null;
  }

  async review(
    scope: EventScope,
    findingId: string,
    status: FindingStatus,
    reviewedBy: string,
    note: string | null,
  ): Promise<void> {
    await this.pool.query(
      `update audit_findings
          set status = $4, reviewed_by = $5::uuid, reviewed_at = now(), review_note = $6
        where tenant_id = $1::uuid and cnpj = $2::char(14) and finding_id = $3`,
      [scope.tenantId, scope.cnpj, findingId, status, reviewedBy, note],
    );
  }

  async alreadyReversed(scope: EventScope, findingId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ existe: boolean }>(
      `select exists (
         select 1 from audit_reversals
          where tenant_id = $1::uuid and cnpj = $2::char(14) and finding_id = $3
       ) as existe`,
      [scope.tenantId, scope.cnpj, findingId],
    );

    return rows[0]?.existe === true;
  }

  async saveReversal(
    scope: EventScope,
    input: {
      findingId: string;
      period: string;
      creditReversedCents: number;
      debitConstitutedCents: number;
      netEffectCents: number;
      verification: string;
      criterionId: string;
      citation: string;
      eventSeq: number;
      appliedBy: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `insert into audit_reversals
         (tenant_id, cnpj, finding_id, period, credit_reversed_cents,
          debit_constituted_cents, net_effect_cents, verification, criterion_id,
          citation, event_seq, applied_by)
       values ($1::uuid, $2::char(14), $3, $4::char(7), $5, $6, $7, $8, $9, $10, $11, $12::uuid)`,
      [
        scope.tenantId,
        scope.cnpj,
        input.findingId,
        input.period,
        input.creditReversedCents,
        input.debitConstitutedCents,
        input.netEffectCents,
        input.verification,
        input.criterionId,
        input.citation,
        input.eventSeq,
        input.appliedBy,
      ],
    );
  }
}
