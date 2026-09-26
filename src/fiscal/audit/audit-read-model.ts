import type pg from 'pg';

import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { PeriodState } from '../shared/fiscal-vocabulary.js';
import {
  propose,
  type AuditFinding,
  type FindingStatus,
  type ImpactSide,
  type ReversalBlocker,
} from './findings.js';
import type { Verification } from './verifications.js';

/**
 * Leitura da auditoria contínua para a tela, o painel e o Book.
 *
 * Separada do `AuditService`, que examina e grava: aqui nada decide sobre o
 * exame. O que se calcula na leitura — os impedimentos de estorno — sai da
 * mesma função pura que a rota de estorno usa, para a tela e o portão nunca
 * darem respostas diferentes.
 */

export interface CriterionView {
  criterion_id: string;
  kind: string;
  citation: string;
  verified: boolean;
  source_ref: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

export interface ExecutionView {
  procedure_id: string;
  status: 'completed' | 'inconclusive';
  inconclusive_reason: string | null;
  population_size: number;
  examined_count: number;
  findings_count: number;
  total_impact_cents: number;
  criterion_id: string;
  criterion_verified: boolean;
  event_seq: number;
  executed_by: string | null;
  executed_at: string;
}

export interface FindingView {
  finding_id: string;
  procedure_id: string;
  period: string;
  subject: string;
  subject_kind: string;
  failed: Verification[];
  impact_cents: number;
  impact_side: ImpactSide;
  likelihood: number;
  impact: number;
  risk_score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  observed_failures: number;
  observed_examined: number;
  criterion_id: string;
  assertable: boolean;
  status: FindingStatus;
  review_note: string | null;
  reviewed_at: string | null;
  verifications: unknown;
  reversed: boolean;
  /** Vazio = o estorno pode ser aplicado. Mesmos códigos do 422 da rota. */
  reversal_blockers: ReversalBlocker[];
}

export interface OverviewClient {
  cnpj: string;
  legal_name: string | null;
  open_findings: number;
  critical: number;
  high: number;
  open_impact_cents: number;
  last_execution_at: string | null;
}

export interface AuditOverview {
  open_findings: { critical: number; high: number; medium: number; low: number; total: number };
  /** Dos abertos, quantos afirmam — critério conferido. O resto é ressalva. */
  open_assertable: number;
  clients_total: number;
  /** CNPJs da carteira em que nenhuma trilha foi executada ainda. */
  clients_never_audited: number;
  last_execution_at: string | null;
  top_clients: OverviewClient[];
}

const iso = (d: Date | string | null): string | null =>
  d === null ? null : new Date(d).toISOString();

export class AuditReadModel {
  constructor(private readonly pool: pg.Pool) {}

  async criteria(ids: readonly string[]): Promise<Map<string, CriterionView>> {
    const { rows } = await this.pool.query<{
      criterion_id: string;
      kind: string;
      citation: string;
      verified: boolean;
      source_ref: string | null;
      valid_from: Date | null;
      valid_to: Date | null;
    }>(
      `select criterion_id, kind, citation, verified, source_ref, valid_from, valid_to
         from evaluation_criteria where criterion_id = any($1::text[])`,
      [ids],
    );

    return new Map(
      rows.map((r) => [
        r.criterion_id,
        {
          criterion_id: r.criterion_id,
          kind: r.kind,
          citation: r.citation,
          verified: r.verified,
          source_ref: r.source_ref,
          valid_from: iso(r.valid_from)?.slice(0, 10) ?? null,
          valid_to: iso(r.valid_to)?.slice(0, 10) ?? null,
        },
      ]),
    );
  }

  /** A execução mais recente de cada trilha na competência. */
  async executions(scope: EventScope, period: string): Promise<ExecutionView[]> {
    const { rows } = await this.pool.query<{
      procedure_id: string;
      status: 'completed' | 'inconclusive';
      inconclusive_reason: string | null;
      population_size: number;
      examined_count: number;
      findings_count: number;
      total_impact_cents: string;
      criterion_id: string;
      criterion_verified: boolean;
      event_seq: string;
      executed_by: string | null;
      executed_at: Date;
    }>(
      `select distinct on (procedure_id)
              procedure_id, status, inconclusive_reason, population_size,
              examined_count, findings_count, total_impact_cents, criterion_id,
              criterion_verified, event_seq, executed_by::text, executed_at
         from audit_executions
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
        order by procedure_id, executed_at desc`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r) => ({
      ...r,
      total_impact_cents: Number(r.total_impact_cents),
      event_seq: Number(r.event_seq),
      executed_at: iso(r.executed_at)!,
    }));
  }

  /**
   * Achados da competência, com os impedimentos de estorno já calculados.
   *
   * O estado da competência vem de `periods`, a leitura que o resto da API usa.
   * A rota de estorno continua a autoridade: ela relê a projeção antes de
   * aplicar, e é ela que recusa.
   */
  async findings(
    scope: EventScope,
    period: string,
    filtro: { status?: FindingStatus; procedureId?: string } = {},
  ): Promise<FindingView[]> {
    const [achados, estado] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `select f.finding_id, f.procedure_id, f.period, f.subject, f.subject_kind,
                f.failed, f.impact_cents, f.impact_side, f.likelihood, f.impact,
                f.risk_score, f.severity, f.observed_failures, f.observed_examined,
                f.criterion_id, f.assertable, f.status, f.review_note, f.reviewed_at,
                f.verifications,
                exists (
                  select 1 from audit_reversals r
                   where r.tenant_id = f.tenant_id and r.cnpj = f.cnpj
                     and r.finding_id = f.finding_id
                ) as reversed
           from audit_findings f
          where f.tenant_id = $1::uuid and f.cnpj = $2::char(14) and f.period = $3::char(7)
            and ($4::text is null or f.status = $4)
            and ($5::text is null or f.procedure_id = $5)
          order by case f.severity
                     when 'critical' then 0 when 'high' then 1
                     when 'medium' then 2 else 3 end,
                   f.impact_cents desc, f.finding_id`,
        [scope.tenantId, scope.cnpj, period, filtro.status ?? null, filtro.procedureId ?? null],
      ),
      this.periodState(scope, period),
    ]);

    return achados.rows.map((r) => paraAchado(r, estado));
  }

  async periodState(scope: EventScope, period: string): Promise<PeriodState> {
    const { rows } = await this.pool.query<{ state: PeriodState }>(
      `select state from periods
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );
    return rows[0]?.state ?? 'open';
  }

  /** O painel do escritório: o que está aberto, e onde. */
  async overview(tenantId: string): Promise<AuditOverview> {
    const [abertos, carteira, porCliente] = await Promise.all([
      this.pool.query<{ severity: string; total: string; assertable: string }>(
        `select severity, count(*)::text as total,
                count(*) filter (where assertable)::text as assertable
           from audit_findings
          where tenant_id = $1::uuid and status = 'open'
          group by severity`,
        [tenantId],
      ),
      this.pool.query<{ clients_total: string; never_audited: string; last_execution_at: Date | null }>(
        `select count(*)::text as clients_total,
                count(*) filter (where not exists (
                  select 1 from audit_executions e
                   where e.tenant_id = c.tenant_id and e.cnpj = c.cnpj
                ))::text as never_audited,
                (select max(executed_at) from audit_executions where tenant_id = $1::uuid)
                  as last_execution_at
           from clients c
          where c.tenant_id = $1::uuid`,
        [tenantId],
      ),
      this.pool.query<{
        cnpj: string;
        legal_name: string | null;
        open_findings: string;
        critical: string;
        high: string;
        open_impact_cents: string;
        last_execution_at: Date | null;
      }>(
        `select f.cnpj, c.legal_name,
                count(*)::text as open_findings,
                count(*) filter (where f.severity = 'critical')::text as critical,
                count(*) filter (where f.severity = 'high')::text as high,
                coalesce(sum(f.impact_cents), 0)::text as open_impact_cents,
                (select max(e.executed_at) from audit_executions e
                  where e.tenant_id = f.tenant_id and e.cnpj = f.cnpj) as last_execution_at
           from audit_findings f
           join clients c on c.tenant_id = f.tenant_id and c.cnpj = f.cnpj
          where f.tenant_id = $1::uuid and f.status = 'open'
          group by f.tenant_id, f.cnpj, c.legal_name
          order by count(*) filter (where f.severity = 'critical') desc,
                   count(*) filter (where f.severity = 'high') desc,
                   sum(f.impact_cents) desc, f.cnpj
          limit 5`,
        [tenantId],
      ),
    ]);

    const porSeveridade = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    let afirmam = 0;
    for (const r of abertos.rows) {
      const n = Number(r.total);
      if (r.severity in porSeveridade) {
        porSeveridade[r.severity as 'critical' | 'high' | 'medium' | 'low'] = n;
      }
      porSeveridade.total += n;
      afirmam += Number(r.assertable);
    }

    const resumo = carteira.rows[0];

    return {
      open_findings: porSeveridade,
      open_assertable: afirmam,
      clients_total: Number(resumo?.clients_total ?? 0),
      clients_never_audited: Number(resumo?.never_audited ?? 0),
      last_execution_at: iso(resumo?.last_execution_at ?? null),
      top_clients: porCliente.rows.map((r) => ({
        cnpj: r.cnpj,
        legal_name: r.legal_name,
        open_findings: Number(r.open_findings),
        critical: Number(r.critical),
        high: Number(r.high),
        open_impact_cents: Number(r.open_impact_cents),
        last_execution_at: iso(r.last_execution_at),
      })),
    };
  }
}

function paraAchado(r: Record<string, unknown>, estado: PeriodState): FindingView {
  const achado: FindingView = {
    finding_id: String(r['finding_id']),
    procedure_id: String(r['procedure_id']),
    period: String(r['period']).trim(),
    subject: String(r['subject']),
    subject_kind: String(r['subject_kind']),
    failed: (r['failed'] ?? []) as Verification[],
    // `bigint` chega do driver como string: a tela somaria texto.
    impact_cents: Number(r['impact_cents']),
    impact_side: r['impact_side'] as ImpactSide,
    likelihood: Number(r['likelihood']),
    impact: Number(r['impact']),
    risk_score: Number(r['risk_score']),
    severity: r['severity'] as FindingView['severity'],
    observed_failures: Number(r['observed_failures']),
    observed_examined: Number(r['observed_examined']),
    criterion_id: String(r['criterion_id']),
    assertable: r['assertable'] === true,
    status: r['status'] as FindingStatus,
    review_note: (r['review_note'] as string | null) ?? null,
    reviewed_at: iso((r['reviewed_at'] as Date | null) ?? null),
    verifications: r['verifications'],
    reversed: r['reversed'] === true,
    reversal_blockers: [],
  };

  const paraProposta: AuditFinding = {
    findingId: achado.finding_id,
    procedureId: achado.procedure_id,
    period: achado.period,
    subject: achado.subject,
    verifications: [],
    failed: achado.failed,
    impactCents: achado.impact_cents,
    impactSide: achado.impact_side,
    risk: {} as AuditFinding['risk'],
    criterion: null,
    assertable: achado.assertable,
    status: achado.status,
  };

  achado.reversal_blockers = [
    ...propose({ finding: paraProposta, periodState: estado, alreadyReversed: achado.reversed })
      .blockers,
  ];
  return achado;
}
