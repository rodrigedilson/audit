import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import type { PeriodState, Regime } from '../shared/fiscal-vocabulary.js';
import { AssessmentService } from '../assessment/assessment.service.js';
import {
  runTrails,
  summarize,
  type AssessmentIssueRecord,
  type ClassificationIssueRecord,
  type RejectionRecord,
  type Severity,
  type TrailDefinition,
  type TrailResult,
  type TrailsSummary,
} from './audit-trails.js';
import { renderBook, type Audience, type BookInput, type BookTraceLine } from './book-pdf.js';

export interface BookOptions {
  audience: Audience;
  whiteLabel: boolean;
  includeTrace: boolean;
}

export interface StoredBook {
  id: string;
  period: string;
  audience: Audience;
  white_label: boolean;
  include_trace: boolean;
  projection_hash: string;
  trails_summary: TrailsSummary;
  pages: number;
  pdf_bytes: number;
  pdf_sha256: string;
  event_seq: number;
  generated_at: string;
}

export interface TrailsReport {
  period: string;
  period_state: PeriodState;
  projection_hash: string;
  reference_tables_loaded: boolean;
  trails: TrailResult[];
  summary: TrailsSummary;
}

/**
 * Trilhas de auditoria e Book de fechamento — diferencial #3.
 *
 * O serviço não calcula nada por conta própria: reúne o que as ondas 4, 5 e 6
 * já gravaram (rejeições no log, saúde do cadastro, apuração) e as nomeia. Se
 * inventasse número aqui, o hash do rodapé não teria o que provar.
 */
export class ReportingService {
  constructor(private readonly pool: Pool) {}

  async definitions(regime?: Regime): Promise<TrailDefinition[]> {
    const { rows } = await this.pool.query<{
      trail_id: string;
      name: string;
      description: string;
      layer: number | null;
      default_severity: Severity;
      tax_scope: TrailDefinition['taxScope'];
      source: TrailDefinition['source'];
      matches: string[];
      applies_to_regimes: Regime[] | null;
    }>(
      `select trail_id, name, description, layer, default_severity, tax_scope,
              source, matches, applies_to_regimes
         from audit_trails
        where active
          and ($1::regime is null or applies_to_regimes is null
               or $1::regime = any (applies_to_regimes))
        order by layer nulls last, trail_id`,
      [regime ?? null],
    );

    return rows.map((r) => ({
      trailId: r.trail_id,
      name: r.name,
      description: r.description,
      layer: r.layer === null ? null : Number(r.layer),
      defaultSeverity: r.default_severity,
      taxScope: r.tax_scope,
      source: r.source,
      matches: r.matches,
    }));
  }

  /** Roda as trilhas de uma competência, sem gerar PDF. É a tela do escritório. */
  async report(scope: EventScope, period: string, regime: Regime): Promise<TrailsReport> {
    const [definitions, rejections, classificationIssues, assessmentIssues, estado, referencia] =
      await Promise.all([
        this.definitions(regime),
        this.loadRejections(scope, period),
        this.loadClassificationIssues(scope),
        this.loadAssessmentIssues(scope, period),
        this.loadPeriod(scope, period),
        this.referenceTablesLoaded(),
      ]);

    const trails = runTrails({
      definitions,
      rejections,
      classificationIssues,
      assessmentIssues,
      periodState: estado.state,
      referenceTablesLoaded: referencia,
    });

    return {
      period,
      period_state: estado.state,
      projection_hash: estado.projectionHash,
      reference_tables_loaded: referencia,
      trails,
      summary: summarize(trails),
    };
  }

  /**
   * Gera o Book e guarda os bytes.
   *
   * O evento `book.generated` sai **depois** do PDF pronto e antes da gravação
   * dos bytes falhar seria pior: o log diria que existe um Book que ninguém
   * consegue baixar. Por isso o insert e o evento vão na mesma ordem em que o
   * orquestrador já garante atomicidade do log, e o insert carrega o
   * `event_seq` — um Book sem evento não fica órfão em silêncio.
   */
  async generate(
    scope: EventScope,
    period: string,
    regime: Regime,
    options: BookOptions,
    orchestrator: FiscalOrchestratorService,
    actor: string,
    generatedBy: string | null,
  ): Promise<StoredBook> {
    const relatorio = await this.report(scope, period, regime);
    const assessment = new AssessmentService(this.pool);
    const apuracao = await assessment.find(scope, period);

    if (!apuracao) {
      throw new BookNotReadyError(
        `Competência ${period} não foi apurada: sem apuração não há números para o Book.`,
      );
    }

    const [cliente, escritorio, trace] = await Promise.all([
      this.loadClient(scope),
      this.loadTenant(scope.tenantId),
      options.includeTrace ? assessment.trace(scope, period, {}) : Promise.resolve([]),
    ]);

    const input: BookInput = {
      tenantName: escritorio,
      cnpj: scope.cnpj,
      legalName: cliente.legalName,
      regime,
      period,
      audience: options.audience,
      whiteLabel: options.whiteLabel,
      includeTrace: options.includeTrace,
      projectionHash: apuracao.projection_hash,
      periodState: relatorio.period_state,
      generatedAt: new Date(),
      trails: relatorio.trails,
      summary: relatorio.summary,
      totals: apuracao.totals as unknown as BookInput['totals'],
      totalDueCents: apuracao.total_due_cents,
      documentsCount: apuracao.documents_count,
      itemsCount: apuracao.items_count,
      coverage: apuracao.coverage,
      notComputable: apuracao.not_computable,
      trace: trace.map(paraLinhaDoBook),
    };

    const rendered = await renderBook(input);

    const outcome = await orchestrator.processIntention({
      action: 'book.generated',
      task_id: `${period}:book`,
      actor,
      period,
      payload: {
        audience: options.audience,
        white_label: options.whiteLabel,
        include_trace: options.includeTrace,
        projection_hash: apuracao.projection_hash,
        pdf_sha256: rendered.sha256,
        pages: rendered.pages,
        trails_failed: relatorio.summary.failed,
        trails_not_applicable: relatorio.summary.not_applicable,
        amount_at_stake_cents: relatorio.summary.amountAtStakeCents,
      },
    });

    if (!outcome.accepted) {
      throw new BookNotReadyError(
        outcome.rejectionReason ?? 'Geração do Book rejeitada pelo pipeline.',
      );
    }

    const { rows } = await this.pool.query<{ id: string; generated_at: string }>(
      `insert into books (
         tenant_id, cnpj, period, audience, white_label, include_trace,
         projection_hash, trails_summary, totals_snapshot, pages,
         pdf, pdf_bytes, pdf_sha256, event_seq, generated_by
       ) values ($1::uuid, $2::char(14), $3::char(7), $4, $5, $6,
                 $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15::uuid)
       returning id, generated_at`,
      [
        scope.tenantId,
        scope.cnpj,
        period,
        options.audience,
        options.whiteLabel,
        options.includeTrace,
        apuracao.projection_hash,
        JSON.stringify(relatorio.summary),
        JSON.stringify(apuracao.totals),
        rendered.pages,
        rendered.pdf,
        rendered.pdf.length,
        rendered.sha256,
        outcome.event!.event_seq,
        generatedBy,
      ],
    );

    return {
      id: rows[0]!.id,
      period,
      audience: options.audience,
      white_label: options.whiteLabel,
      include_trace: options.includeTrace,
      projection_hash: apuracao.projection_hash,
      trails_summary: relatorio.summary,
      pages: rendered.pages,
      pdf_bytes: rendered.pdf.length,
      pdf_sha256: rendered.sha256,
      event_seq: outcome.event!.event_seq,
      generated_at: rows[0]!.generated_at,
    };
  }

  /** Metadados dos Books da competência, sem os bytes. */
  async list(scope: EventScope, period: string): Promise<StoredBook[]> {
    const { rows } = await this.pool.query(
      `select id, period, audience, white_label, include_trace, projection_hash,
              trails_summary, pages, pdf_bytes, pdf_sha256, event_seq, generated_at
         from books
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
        order by generated_at desc`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r: Record<string, unknown>) => ({
      id: String(r['id']),
      period: String(r['period']).trim(),
      audience: r['audience'] as Audience,
      white_label: Boolean(r['white_label']),
      include_trace: Boolean(r['include_trace']),
      projection_hash: String(r['projection_hash']),
      trails_summary: r['trails_summary'] as TrailsSummary,
      pages: Number(r['pages']),
      pdf_bytes: Number(r['pdf_bytes']),
      pdf_sha256: String(r['pdf_sha256']),
      event_seq: Number(r['event_seq']),
      generated_at: new Date(String(r['generated_at'])).toISOString(),
    }));
  }

  async download(
    scope: EventScope,
    bookId: string,
  ): Promise<{ pdf: Buffer; sha256: string; period: string } | null> {
    const { rows } = await this.pool.query<{
      pdf: Buffer;
      pdf_sha256: string;
      period: string;
    }>(
      `select pdf, pdf_sha256, period
         from books
        where id = $1::uuid and tenant_id = $2::uuid and cnpj = $3::char(14)`,
      [bookId, scope.tenantId, scope.cnpj],
    );

    const linha = rows[0];
    if (!linha) {
      return null;
    }

    return { pdf: linha.pdf, sha256: linha.pdf_sha256, period: String(linha.period).trim() };
  }

  // ------------------------------------------------------------- coletores

  /**
   * Rejeições do log da competência.
   *
   * Vem do event log e não de uma tabela de relatório: é o mesmo registro que
   * o `POST /verify` reprocessa, então o que o Book afirma é o que o replay
   * reproduz.
   */
  private async loadRejections(scope: EventScope, period: string): Promise<RejectionRecord[]> {
    const { rows } = await this.pool.query<{
      event_seq: string;
      task_id: string;
      payload: Record<string, unknown>;
    }>(
      `select event_seq, task_id, payload
         from events
        where tenant_id = $1::uuid and cnpj = $2::char(14)
          and action = 'output.rejected' and period = $3::char(7)
        order by event_seq`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r) => ({
      reason: String(r.payload['reason'] ?? 'unknown'),
      layer: Number(r.payload['validation_layer'] ?? 0),
      details: String(r.payload['details'] ?? ''),
      subject: String(r.payload['filename'] ?? r.task_id),
      eventSeq: Number(r.event_seq),
    }));
  }

  /**
   * Saúde do cadastro com propagação.
   *
   * Não é filtrado por competência de propósito: a classificação vigente de um
   * item vale para toda nota que o use, e é exatamente essa propagação — quantas
   * notas já emitidas carregam o erro — que os verificadores gratuitos não
   * mostram.
   */
  private async loadClassificationIssues(
    scope: EventScope,
  ): Promise<ClassificationIssueRecord[]> {
    const { rows } = await this.pool.query<{
      item_id: string;
      reason: string;
      severity: Severity;
      message: string;
      documentos: string;
      valor: string;
    }>(
      `with vigente as (
         select distinct on (c.item_id) c.item_id, c.health_issues
           from item_classifications c
          where c.tenant_id = $1::uuid and c.cnpj = $2::char(14)
          order by c.item_id, c.effective_from desc
       ),
       propagacao as (
         select item_id,
                outbound_documents_affected + inbound_documents_affected as documentos,
                total_cents_affected as valor
           from item_propagation($1::uuid, $2::char(14))
       )
       select v.item_id,
              issue->>'reason'   as reason,
              issue->>'severity' as severity,
              issue->>'message'  as message,
              coalesce(p.documentos, 0)::text as documentos,
              coalesce(p.valor, 0)::text      as valor
         from vigente v
         left join propagacao p on p.item_id = v.item_id,
              jsonb_array_elements(v.health_issues) as issue
        order by v.item_id`,
      [scope.tenantId, scope.cnpj],
    );

    return rows.map((r) => ({
      itemId: r.item_id,
      reason: r.reason,
      severity: r.severity,
      message: r.message,
      documentsAffected: Number(r.documentos),
      // O valor em risco é do item, não da inconsistência. Um item com duas
      // inconsistências contaria o mesmo valor duas vezes, e o total do Book
      // ficaria acima do que está de fato em jogo.
      amountAtStakeCents: 0,
    }));
  }

  private async loadAssessmentIssues(
    scope: EventScope,
    period: string,
  ): Promise<AssessmentIssueRecord[]> {
    const { rows } = await this.pool.query<{ not_computable: AssessmentIssueRecord[] | null }>(
      `select not_computable
         from assessments
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows[0]?.not_computable ?? [];
  }

  private async loadPeriod(
    scope: EventScope,
    period: string,
  ): Promise<{ state: PeriodState; projectionHash: string }> {
    const { rows } = await this.pool.query<{ state: PeriodState; projection_hash: string | null }>(
      `select state, projection_hash
         from periods
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    const linha = rows[0];
    if (!linha) {
      throw new BookNotReadyError(`Competência ${period} não está aberta para este CNPJ.`);
    }

    return { state: linha.state, projectionHash: linha.projection_hash ?? '' };
  }

  /**
   * Sem tabela oficial carregada as trilhas de código não conferiram nada, e
   * dizer "passou" seria afirmar uma verificação que não aconteceu.
   */
  private async referenceTablesLoaded(): Promise<boolean> {
    const { rows } = await this.pool.query<{ codigos: string; pares: string }>(
      `select (select count(*)::text from fiscal_codes)   as codigos,
              (select count(*)::text from cclasstrib_cst) as pares`,
    );
    return Number(rows[0]!.codigos) > 0 && Number(rows[0]!.pares) > 0;
  }

  private async loadClient(scope: EventScope): Promise<{ legalName: string }> {
    const { rows } = await this.pool.query<{ legal_name: string | null }>(
      'select legal_name from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    return { legalName: rows[0]?.legal_name ?? scope.cnpj };
  }

  private async loadTenant(tenantId: string): Promise<string> {
    const { rows } = await this.pool.query<{ name: string }>(
      'select name from tenants where id = $1::uuid',
      [tenantId],
    );
    return rows[0]?.name ?? 'Escritório';
  }
}

/** O Book depende da apuração e da competência; sem elas não há o que renderizar. */
export class BookNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookNotReadyError';
  }
}

function paraLinhaDoBook(linha: Record<string, unknown>): BookTraceLine {
  return {
    accessKey: String(linha['access_key']),
    line: Number(linha['line']),
    tax: String(linha['tax']),
    itemCode: String(linha['item_code']),
    direction: String(linha['direction']),
    baseCents: Number(linha['base_cents']),
    rate: Number(linha['rate']),
    amountCents: Number(linha['amount_cents']),
  };
}
