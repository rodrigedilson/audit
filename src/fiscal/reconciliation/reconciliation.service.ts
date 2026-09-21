import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import type { PeriodState, Regime } from '../shared/fiscal-vocabulary.js';
import {
  compare,
  type ComparableLine,
  type ComparisonSummary,
  type Divergence,
} from './divergence-analysis.js';
import { parseFiscoUpload, type RejectedRow } from './fisco-upload.js';
import {
  derivePendencies,
  deriveDeadlines,
  type DatedDeadline,
  type DeadlineRule,
  type Pendency,
  type PeriodSnapshot,
} from './deadlines.js';

export type FiscoSource = 'manual_upload' | 'official_api';

export interface UploadOutcome {
  period: string;
  source: FiscoSource;
  reference: string;
  line_level: boolean;
  lines_count: number;
  rejected: RejectedRow[];
  totals: Record<string, number>;
  divergences: Divergence[];
  summary: ComparisonSummary;
  event_seq: number;
  projection_hash: string;
}

export interface StoredComparison {
  period: string;
  source: FiscoSource;
  reference: string;
  line_level: boolean;
  lines_count: number;
  totals: Record<string, number>;
  uploaded_at: string;
  event_seq: number;
  divergences: Divergence[];
  summary: ComparisonSummary;
}

export interface Calendar {
  horizon_days: number;
  /**
   * `false` significa que nenhum prazo normativo está carregado — e portanto que
   * a lista vazia de prazos não é "nada a vencer". A distinção é o produto.
   */
  normative_rules_loaded: boolean;
  deadlines: CalendarRow[];
  pendencies: Pendency[];
}

export interface CalendarRow {
  cnpj: string;
  legal_name: string | null;
  regime: Regime;
  period: string | null;
  kind: string;
  name: string;
  due_date: string;
  days_left: number;
  severity: string;
  nature: string;
  legal_basis: string | null;
  state: string;
}

export class ComparisonNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparisonNotReadyError';
  }
}

/**
 * Contra-apuração e calendário — diferencial #5.
 *
 * As divergências são **persistidas**, e não recalculadas na leitura: é o que o
 * contador vai contestar, e ele precisa mostrar depois o que o sistema apontou
 * com a proposta daquele dia. Recalcular depois de reapurar mudaria a lista sem
 * mudar a contestação já protocolada.
 */
export class ReconciliationService {
  constructor(private readonly pool: Pool) {}

  async upload(
    scope: EventScope,
    period: string,
    input: { source: FiscoSource; reference: string; content: string },
    orchestrator: FiscalOrchestratorService,
    actor: string,
    uploadedBy: string | null,
  ): Promise<UploadOutcome> {
    const proposta = parseFiscoUpload(input.content);
    const nossas = await this.loadOurLines(scope, period);

    if (nossas.length === 0) {
      throw new ComparisonNotReadyError(
        `Competência ${period} não foi apurada. Sem a nossa apuração não há o que ` +
          'comparar, e registrar a proposta do Fisco sozinha daria a impressão de ' +
          'conferência que não aconteceu.',
      );
    }

    const resultado = compare({
      ours: nossas,
      fisco: proposta.lines,
      fiscoTotals: proposta.totals,
      lineLevel: proposta.lineLevel,
    });

    const outcome = await orchestrator.processIntention({
      action: 'assessment.compared',
      task_id: period,
      actor,
      period,
      payload: {
        source: input.source,
        reference: input.reference,
        line_level: proposta.lineLevel,
        lines_received: proposta.lines.length,
        lines_rejected: proposta.rejected.length,
        lines_compared: resultado.summary.linesCompared,
        divergences: resultado.summary.divergencesCount,
        exposure_cents: resultado.summary.exposureCents,
        credit_loss_cents: resultado.summary.creditLossCents,
        credit_at_risk_cents: resultado.summary.creditAtRiskCents,
      },
    });

    if (!outcome.accepted) {
      throw new ComparisonNotReadyError(
        outcome.rejectionReason ?? 'Comparação rejeitada pelo pipeline.',
      );
    }

    const eventSeq = outcome.event!.event_seq;
    await this.persist(scope, period, input, proposta, resultado, eventSeq, uploadedBy);

    return {
      period,
      source: input.source,
      reference: input.reference,
      line_level: proposta.lineLevel,
      lines_count: proposta.lines.length,
      rejected: proposta.rejected,
      totals: proposta.totals,
      divergences: resultado.divergences,
      summary: resultado.summary,
      event_seq: eventSeq,
      projection_hash: outcome.projection!.projection_hash_sha256,
    };
  }

  async find(scope: EventScope, period: string): Promise<StoredComparison | null> {
    const { rows } = await this.pool.query<{
      source: FiscoSource;
      reference: string;
      line_level: boolean;
      lines_count: number;
      totals: Record<string, number>;
      uploaded_at: string;
      event_seq: string;
    }>(
      `select source, reference, line_level, lines_count, totals, uploaded_at, event_seq
         from fisco_assessments
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    const cabeca = rows[0];
    if (!cabeca) {
      return null;
    }

    const divergences = await this.loadDivergences(scope, period);

    return {
      period,
      source: cabeca.source,
      reference: cabeca.reference,
      line_level: cabeca.line_level,
      lines_count: Number(cabeca.lines_count),
      totals: cabeca.totals,
      uploaded_at: new Date(cabeca.uploaded_at).toISOString(),
      event_seq: Number(cabeca.event_seq),
      divergences,
      summary: await this.loadSummary(scope, period, cabeca.line_level),
    };
  }

  /**
   * O calendário da carteira: prazos datados de um lado, pendências derivadas do
   * outro. Nunca na mesma lista — ver o comentário de `deadlines.ts`.
   */
  async calendar(tenantId: string, horizonDays: number): Promise<Calendar> {
    const [regras, periodos] = await Promise.all([
      this.loadDeadlineRules(),
      this.loadPeriodSnapshots(tenantId),
    ]);

    await this.syncDeadlines(tenantId, regras, periodos);

    const { rows } = await this.pool.query<CalendarRow & { days_left: string }>(
      'select * from portfolio_deadlines($1::uuid, $2::integer)',
      [tenantId, horizonDays],
    );

    return {
      horizon_days: horizonDays,
      normative_rules_loaded: regras.length > 0,
      deadlines: rows.map((r) => ({
        ...r,
        cnpj: String(r.cnpj).trim(),
        period: r.period === null ? null : String(r.period).trim(),
        due_date: String(r.due_date).slice(0, 10),
        days_left: Number(r.days_left),
      })),
      pendencies: derivePendencies({ periods: periodos, today: new Date() }),
    };
  }

  // ------------------------------------------------------------ escrita

  private async persist(
    scope: EventScope,
    period: string,
    input: { source: FiscoSource; reference: string },
    proposta: { lines: readonly ComparableLine[]; totals: Record<string, number>; lineLevel: boolean },
    resultado: { divergences: readonly Divergence[]; summary: ComparisonSummary },
    eventSeq: number,
    uploadedBy: string | null,
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      // Nova proposta substitui a anterior por inteiro: manter as divergências
      // da proposta antiga misturadas com as da nova daria dois números para a
      // mesma competência, e nenhum deles seria defensável.
      await client.query(
        `insert into fisco_assessments (
           tenant_id, cnpj, period, source, reference, line_level, totals, lines_count,
           event_seq, uploaded_by, uploaded_at
         ) values ($1::uuid, $2::char(14), $3::char(7), $4::fisco_source, $5, $6,
                   $7::jsonb, $8, $9, $10::uuid, now())
         on conflict (tenant_id, cnpj, period) do update set
           source = excluded.source,
           reference = excluded.reference,
           line_level = excluded.line_level,
           totals = excluded.totals,
           lines_count = excluded.lines_count,
           event_seq = excluded.event_seq,
           uploaded_by = excluded.uploaded_by,
           uploaded_at = excluded.uploaded_at`,
        [
          scope.tenantId,
          scope.cnpj,
          period,
          input.source,
          input.reference,
          proposta.lineLevel,
          JSON.stringify(proposta.totals),
          proposta.lines.length,
          eventSeq,
          uploadedBy,
        ],
      );

      await client.query(
        `delete from fisco_assessment_lines
          where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
        [scope.tenantId, scope.cnpj, period],
      );

      for (const linha of proposta.lines) {
        await client.query(
          `insert into fisco_assessment_lines (
             tenant_id, cnpj, period, access_key, line, tax, direction,
             base_cents, rate, amount_cents
           ) values ($1::uuid, $2::char(14), $3::char(7), $4::char(44), $5, $6, $7, $8, $9, $10)`,
          [
            scope.tenantId,
            scope.cnpj,
            period,
            linha.accessKey,
            linha.line,
            linha.tax,
            linha.direction,
            linha.baseCents,
            linha.rate,
            linha.amountCents,
          ],
        );
      }

      await client.query(
        `delete from assessment_divergences
          where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
        [scope.tenantId, scope.cnpj, period],
      );

      for (const divergencia of resultado.divergences) {
        await client.query(
          `insert into assessment_divergences (
             tenant_id, cnpj, period, scope, subject, tax, direction, access_key, line,
             our_cents, fisco_cents, difference_cents, probable_cause, severity, event_seq
           ) values ($1::uuid, $2::char(14), $3::char(7), $4, $5, $6, $7, $8::char(44), $9,
                     $10, $11, $12, $13, $14, $15)`,
          [
            scope.tenantId,
            scope.cnpj,
            period,
            divergencia.scope,
            divergencia.subject,
            divergencia.tax,
            divergencia.direction,
            divergencia.accessKey,
            divergencia.line,
            divergencia.ourCents,
            divergencia.fiscoCents,
            divergencia.differenceCents,
            divergencia.probableCause,
            divergencia.severity,
            eventSeq,
          ],
        );
      }

      await client.query('commit');
    } catch (causa) {
      await client.query('rollback');
      throw causa;
    } finally {
      client.release();
    }
  }

  /**
   * Materializa os prazos datados.
   *
   * Idempotente pelo índice único: reprocessar o calendário não duplica linha.
   * Não atualiza o que já existe — um prazo já avisado não deve mudar de data
   * debaixo do escritório porque a regra foi reeditada.
   */
  private async syncDeadlines(
    tenantId: string,
    regras: readonly DeadlineRule[],
    periodos: readonly PeriodSnapshot[],
  ): Promise<void> {
    const normativos = deriveDeadlines(regras, periodos);
    const fatos = await this.certificateDeadlines(tenantId);

    for (const prazo of [...normativos, ...fatos]) {
      await this.pool.query(
        `insert into deadlines (
           tenant_id, cnpj, period, rule_id, kind, name, due_date, severity, nature, legal_basis
         ) values ($1::uuid, $2::char(14), $3::char(7), $4, $5, $6, $7::date, $8, $9, $10)
         on conflict (tenant_id, cnpj, kind, coalesce(period, '')) do nothing`,
        [
          tenantId,
          prazo.cnpj,
          prazo.period,
          prazo.ruleId,
          prazo.kind,
          prazo.name,
          prazo.dueDate,
          prazo.severity,
          prazo.nature,
          prazo.legalBasis,
        ],
      );
    }
  }

  /**
   * Validade do certificado A1 é data que o sistema conhece de fato — `nature:
   * 'fato'`, sem base legal, porque não é prazo de norma: é o dia em que a
   * coleta automática para de funcionar.
   */
  private async certificateDeadlines(tenantId: string): Promise<DatedDeadline[]> {
    const { rows } = await this.pool.query<{ cnpj: string; valid_to: string }>(
      `select cnpj, valid_to
         from certificates
        where tenant_id = $1::uuid and valid_to > now()`,
      [tenantId],
    );

    return rows.map((r) => ({
      ruleId: null,
      kind: 'certificado_a1_vencendo',
      name: 'Certificado A1 vence',
      cnpj: String(r.cnpj).trim(),
      period: null,
      dueDate: new Date(r.valid_to).toISOString().slice(0, 10),
      severity: 'high' as const,
      nature: 'fato' as const,
      legalBasis: null,
    }));
  }

  // ------------------------------------------------------------ leitura

  private async loadOurLines(scope: EventScope, period: string): Promise<ComparableLine[]> {
    const { rows } = await this.pool.query<{
      access_key: string;
      line: number;
      tax: string;
      direction: string;
      base_cents: string;
      rate: string;
      amount_cents: string;
    }>(
      `select access_key, line, tax, direction, base_cents, rate, amount_cents
         from assessment_lines
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r) => ({
      accessKey: String(r.access_key).trim(),
      line: Number(r.line),
      tax: r.tax,
      direction: r.direction === 'inbound' ? 'inbound' : 'outbound',
      baseCents: Number(r.base_cents),
      rate: Number(r.rate),
      amountCents: Number(r.amount_cents),
    }));
  }

  private async loadDivergences(scope: EventScope, period: string): Promise<Divergence[]> {
    const { rows } = await this.pool.query(
      `select scope, subject, tax, direction, access_key, line,
              our_cents, fisco_cents, difference_cents, probable_cause, severity
         from assessment_divergences
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
        order by case severity
                   when 'critical' then 0 when 'high' then 1
                   when 'medium' then 2 else 3 end,
                 abs(difference_cents) desc`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r: Record<string, unknown>) => ({
      scope: r['scope'] as Divergence['scope'],
      subject: String(r['subject']),
      tax: String(r['tax']),
      direction: (r['direction'] ?? null) as Divergence['direction'],
      accessKey: r['access_key'] === null ? null : String(r['access_key']).trim(),
      line: r['line'] === null ? null : Number(r['line']),
      ourCents: Number(r['our_cents']),
      fiscoCents: Number(r['fisco_cents']),
      differenceCents: Number(r['difference_cents']),
      probableCause: r['probable_cause'] as Divergence['probableCause'],
      severity: r['severity'] as Divergence['severity'],
    }));
  }

  /**
   * Resumo recalculado a partir das divergências gravadas, e não guardado.
   *
   * Guardá-lo abriria a chance de o resumo discordar da lista que ele resume —
   * e é o resumo que o escritório olha primeiro.
   */
  private async loadSummary(
    scope: EventScope,
    period: string,
    lineLevel: boolean,
  ): Promise<ComparisonSummary> {
    const { rows } = await this.pool.query<{
      probable_cause: string;
      severity: string;
      total: string;
      valor: string;
    }>(
      `select probable_cause, severity, count(*)::text as total,
              sum(abs(difference_cents))::text as valor
         from assessment_divergences
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
        group by probable_cause, severity`,
      [scope.tenantId, scope.cnpj, period],
    );

    const porCausa = (causa: string): number =>
      rows.filter((r) => r.probable_cause === causa).reduce((s, r) => s + Number(r.valor), 0);

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const linha of rows) {
      bySeverity[linha.severity as keyof typeof bySeverity] += Number(linha.total);
    }

    const { rows: comparadas } = await this.pool.query<{ total: string }>(
      `select count(*)::text as total
         from assessment_lines a
         join fisco_assessment_lines f
           on f.tenant_id = a.tenant_id and f.cnpj = a.cnpj and f.period = a.period
          and f.access_key = a.access_key and f.line = a.line and f.tax = a.tax
        where a.tenant_id = $1::uuid and a.cnpj = $2::char(14) and a.period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    return {
      divergencesCount: rows.reduce((s, r) => s + Number(r.total), 0),
      exposureCents: porCausa('debito_nao_escriturado'),
      creditLossCents: porCausa('credito_nao_aproveitado'),
      creditAtRiskCents: porCausa('credito_glosado'),
      bySeverity,
      linesCompared: Number(comparadas[0]!.total),
      lineLevel,
    };
  }

  private async loadDeadlineRules(): Promise<DeadlineRule[]> {
    const { rows } = await this.pool.query<{
      rule_id: string;
      name: string;
      description: string;
      applies_to_regimes: Regime[] | null;
      months_after: number | null;
      day_of_month: number | null;
      fixed_date: string | null;
      warn_days: number;
      severity: DeadlineRule['severity'];
      legal_basis: string;
    }>(
      `select rule_id, name, description, applies_to_regimes, months_after,
              day_of_month, fixed_date, warn_days, severity, legal_basis
         from deadline_rules
        where active and nature = 'normativo'`,
    );

    return rows.map((r) => ({
      ruleId: r.rule_id,
      name: r.name,
      description: r.description,
      appliesToRegimes: r.applies_to_regimes,
      monthsAfter: r.months_after === null ? null : Number(r.months_after),
      dayOfMonth: r.day_of_month === null ? null : Number(r.day_of_month),
      fixedDate: r.fixed_date === null ? null : new Date(r.fixed_date).toISOString().slice(0, 10),
      warnDays: Number(r.warn_days),
      severity: r.severity,
      legalBasis: r.legal_basis,
    }));
  }

  /**
   * Competências da carteira com o que o calendário precisa.
   *
   * Limitado às não confirmadas e às de proposta recebida: uma carteira de 300
   * CNPJs com dois anos de histórico traria milhares de competências fechadas
   * que não geram pendência nenhuma.
   */
  private async loadPeriodSnapshots(tenantId: string): Promise<PeriodSnapshot[]> {
    const { rows } = await this.pool.query<{
      cnpj: string;
      period: string;
      state: PeriodState;
      regime: Regime;
      created_at: string;
      uploaded_at: string | null;
      line_level: boolean | null;
      criticas: string | null;
      altas: string | null;
    }>(
      `select p.cnpj, p.period, p.state, c.regime, p.created_at,
              f.uploaded_at, f.line_level,
              (select count(*)::text from assessment_divergences d
                where d.tenant_id = p.tenant_id and d.cnpj = p.cnpj
                  and d.period = p.period and d.severity = 'critical') as criticas,
              (select count(*)::text from assessment_divergences d
                where d.tenant_id = p.tenant_id and d.cnpj = p.cnpj
                  and d.period = p.period and d.severity = 'high') as altas
         from periods p
         join clients c on c.tenant_id = p.tenant_id and c.cnpj = p.cnpj
         left join fisco_assessments f
           on f.tenant_id = p.tenant_id and f.cnpj = p.cnpj and f.period = p.period
        where p.tenant_id = $1::uuid
          and (p.state <> 'confirmed' or f.uploaded_at is not null)
        order by p.period, p.cnpj`,
      [tenantId],
    );

    return rows.map((r) => ({
      cnpj: String(r.cnpj).trim(),
      period: String(r.period).trim(),
      state: r.state,
      regime: r.regime,
      openedAt: new Date(r.created_at).toISOString(),
      ...(r.uploaded_at === null
        ? {}
        : {
            fisco: {
              uploadedAt: new Date(r.uploaded_at).toISOString(),
              lineLevel: Boolean(r.line_level),
              criticalDivergences: Number(r.criticas ?? 0),
              highDivergences: Number(r.altas ?? 0),
            },
          }),
    }));
  }
}
