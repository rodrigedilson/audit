import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { EventScope } from '../../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../../esaa/orchestrator/fiscal-orchestrator.service.js';
import { conferirExtracao, type CapagExtraction } from './capag-extraction.js';
import type { CapagExtractorPort } from './capag-extractor.port.js';
import { extractDocumentText } from './document-text.js';

/**
 * Demonstrativos de CAPAG por CNPJ, e a fórmula de referência.
 *
 * O caminho de um demonstrativo: texto do arquivo → extração pelo modelo →
 * conferência trecho a trecho pelo código → reprodução da conta → evento no
 * log → linha em `capag_statements`. O arquivo não é guardado.
 */

export class CapagExtractorNotConfiguredError extends Error {
  constructor() {
    super('A extração da CAPAG usa o modelo de linguagem, e ANTHROPIC_API_KEY não está configurada neste ambiente.');
    this.name = 'CapagExtractorNotConfiguredError';
  }
}

export interface CapagStatementView {
  statement_id: string;
  extracted_at: string;
  document_sha256: string;
  document_kind: string;
  reference_date: string | null;
  group: string | null;
  values_cents: Record<string, number>;
  printed_capag_cents: number | null;
  computed_capag_cents: number | null;
  total_debt_cents: number | null;
  printed_band: string | null;
  reproduces: boolean;
  verified: boolean;
  problems: string[];
  /** A extração com o trecho literal de cada número, para a tela mostrar de onde veio. */
  extraction: CapagExtraction;
  model: string;
}

export interface CapagReferenceView {
  group: string;
  income_multiplier: number;
  terms: unknown;
  sources: unknown;
  legal_basis: string | null;
  extracted_at: string;
  /** `oficial_pgfn`: lida da página da PGFN no gov.br. `doutrina`: qualquer outra fonte. */
  source_kind: 'oficial_pgfn' | 'doutrina';
  /** Só a oficial, com todo coeficiente achado literal na página. Doutrina nunca. */
  verified: boolean;
}

interface LinhaDoDemonstrativo {
  statement_id: string;
  extracted_at: Date;
  document_sha256: string;
  document_kind: string;
  /** `date` vem do driver como `Date` com fuso; o texto é o que o contrato promete. */
  reference_date_text: string | null;
  capag_group: string | null;
  values_cents: Record<string, number>;
  printed_capag_cents: string | null;
  computed_capag_cents: string | null;
  total_debt_cents: string | null;
  printed_band: string | null;
  reproduces: boolean;
  verified: boolean;
  problems: string[];
  extraction: CapagExtraction;
  model: string;
}

const numero = (v: string | null): number | null => (v === null ? null : Number(v));

function paraView(r: LinhaDoDemonstrativo): CapagStatementView {
  return {
    statement_id: r.statement_id,
    extracted_at: r.extracted_at.toISOString(),
    document_sha256: r.document_sha256,
    document_kind: r.document_kind,
    reference_date: r.reference_date_text,
    group: r.capag_group,
    values_cents: r.values_cents,
    printed_capag_cents: numero(r.printed_capag_cents),
    computed_capag_cents: numero(r.computed_capag_cents),
    total_debt_cents: numero(r.total_debt_cents),
    printed_band: r.printed_band,
    reproduces: r.reproduces,
    verified: r.verified,
    problems: r.problems,
    extraction: r.extraction,
    model: r.model,
  };
}

export class CapagService {
  constructor(
    private readonly pool: Pool,
    private readonly extractor: CapagExtractorPort | undefined,
  ) {}

  get configured(): boolean {
    return this.extractor !== undefined;
  }

  async importStatement(input: {
    scope: EventScope;
    orchestrator: FiscalOrchestratorService;
    actor: string;
    bytes: Uint8Array;
    contentType: string | null;
  }): Promise<CapagStatementView> {
    if (this.extractor === undefined) throw new CapagExtractorNotConfiguredError();

    const documento = await extractDocumentText(input.bytes, input.contentType);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const extracao = await this.extractor.extract({ text: documento.text, hint: 'demonstrativo' });
    const conferencia = conferirExtracao(extracao, documento.text);

    const problems =
      extracao.documentKind === 'demonstrativo_regularize'
        ? conferencia.problems
        : ['O documento não parece um demonstrativo de CAPAG do REGULARIZE.', ...conferencia.problems];
    const verified = conferencia.verified && problems.length === conferencia.problems.length;

    const statementId = randomUUID();
    const evento = await input.orchestrator.processIntention({
      action: 'capag.statement_imported',
      task_id: statementId,
      actor: input.actor,
      payload: { statement_id: statementId, document_sha256: sha256, reproduces: conferencia.reproduces, verified },
    });
    if (!evento.accepted) {
      throw new Error(`O demonstrativo não foi registrado no log: ${evento.rejectionReason ?? 'recusado'}.`);
    }

    const { rows } = await this.pool.query<LinhaDoDemonstrativo>(
      `insert into capag_statements (
         statement_id, tenant_id, cnpj, document_sha256, document_kind, reference_date, capag_group,
         extraction, values_cents, printed_capag_cents, total_debt_cents, printed_band, computed_capag_cents,
         reproduces, verified, problems, model, imported_by, event_seq
       ) values ($1::uuid, $2::uuid, $3::char(14), $4, $5, $6::date, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13,
                 $14, $15, $16::jsonb, $17, $18::uuid, $19)
       returning *, reference_date::text as reference_date_text`,
      [
        statementId,
        input.scope.tenantId,
        input.scope.cnpj,
        sha256,
        documento.kind,
        conferencia.referenceDate,
        extracao.group,
        JSON.stringify(extracao),
        JSON.stringify(conferencia.valuesCents),
        conferencia.printedCapagCents,
        conferencia.totalDebtCents,
        conferencia.band,
        conferencia.computedCapagCents,
        conferencia.reproduces,
        verified,
        JSON.stringify(problems),
        this.extractor.name,
        input.actor,
        evento.event!.event_seq,
      ],
    );
    return paraView(rows[0]!);
  }

  async latest(scope: EventScope): Promise<CapagStatementView | null> {
    const { rows } = await this.pool.query<LinhaDoDemonstrativo>(
      `select *, reference_date::text as reference_date_text from capag_statements
        where tenant_id = $1::uuid and cnpj = $2::char(14)
        order by extracted_at desc limit 1`,
      [scope.tenantId, scope.cnpj],
    );
    return rows[0] === undefined ? null : paraView(rows[0]);
  }

  /**
   * A fórmula de referência de cada grupo: a oficial conferida, quando há, e
   * senão a de doutrina mais recente.
   */
  async references(): Promise<CapagReferenceView[]> {
    const { rows } = await this.pool.query<{
      capag_group: string;
      income_multiplier: string;
      terms: unknown;
      sources: unknown;
      legal_basis: string | null;
      extracted_at: Date;
      source_kind: 'oficial_pgfn' | 'doutrina';
      verified: boolean;
    }>(
      `select distinct on (capag_group) capag_group, income_multiplier::text, terms, sources, legal_basis, extracted_at,
              source_kind, verified
         from capag_reference_formulas order by capag_group, verified desc, extracted_at desc`,
    );
    return rows.map((r) => ({
      group: r.capag_group,
      income_multiplier: Number(r.income_multiplier),
      terms: r.terms,
      sources: r.sources,
      legal_basis: r.legal_basis,
      extracted_at: r.extracted_at.toISOString(),
      source_kind: r.source_kind,
      verified: r.verified,
    }));
  }
}
