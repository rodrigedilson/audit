/**
 * Persistência da EFD ICMS/IPI importada.
 *
 * Guarda o cabeçalho na `sped_files` — a mesma tabela da EFD-Contribuições,
 * discriminada pela coluna `layout` — e, ao lado, o resumo por documento e a
 * apuração declarada.
 *
 * O que **não** é guardado: item a item. As conferências precisam, por
 * documento, de três somas de ICMS (itens, consolidação e o do próprio C100), e
 * gravar cada C170 custaria milhões de linhas por carteira para responder às
 * mesmas perguntas.
 *
 * O que também não é guardado: o resultado da conciliação. Ele é derivado na
 * leitura, para que uma conferência nova valha também para arquivo antigo.
 */
import type { Pool, PoolClient } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type {
  EfdIcmsAssessment,
  EfdIcmsResult,
  EfdIpiAssessment,
} from '../ingestion/efd-icms-ipi.parser.js';
import {
  summarizeEfdIcmsIpi,
  type IcmsIpiDocumentSummary,
} from './icms-ipi-checks.js';

export interface EfdIcmsFileRow {
  id: string;
  kind: 'original' | 'retificadora';
  layoutVersion: string;
  counts: Record<string, number>;
  importedAt: string;
}

/**
 * Documentos gravados por comando. São 11 parâmetros por documento, e o
 * Postgres aceita 65535 por comando — 500 deixa folga larga.
 */
const LOTE = 500;

export class EfdIcmsIpiRepository {
  constructor(private readonly pool: Pool) {}

  async persist(
    scope: EventScope,
    efd: EfdIcmsResult,
    reference: string,
    eventSeq: number,
    importedBy: string | null,
  ): Promise<string> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      const spedFileId = await this.upsertFile(
        client,
        scope,
        efd,
        reference,
        eventSeq,
        importedBy,
      );

      // Substitui por inteiro: o `on conflict` reaproveita o id, então as linhas
      // da importação anterior sairiam misturadas com as novas.
      await client.query('delete from efd_icms_documents where sped_file_id = $1::uuid', [
        spedFileId,
      ]);

      await this.insertDocuments(
        client,
        scope,
        spedFileId,
        summarizeEfdIcmsIpi(efd).documents,
      );
      await this.upsertAssessment(client, scope, spedFileId, efd);

      await client.query('commit');
      return spedFileId;
    } catch (causa) {
      await client.query('rollback');
      throw causa;
    } finally {
      client.release();
    }
  }

  /** A retificadora substitui a original, como na própria EFD. */
  private async upsertFile(
    client: PoolClient,
    scope: EventScope,
    efd: EfdIcmsResult,
    reference: string,
    eventSeq: number,
    importedBy: string | null,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into sped_files (
         tenant_id, cnpj, period, layout, kind, layout_version, reference,
         company_name, documents_count, rejected_count, counts, event_seq,
         imported_by, imported_at
       ) values ($1::uuid, $2::char(14), $3::char(7), 'icms_ipi', $4::sped_kind,
                 $5, $6, $7, $8, $9, $10::jsonb, $11, $12::uuid, now())
       on conflict (tenant_id, cnpj, period, layout) do update set
         kind = excluded.kind,
         layout_version = excluded.layout_version,
         reference = excluded.reference,
         company_name = excluded.company_name,
         documents_count = excluded.documents_count,
         rejected_count = excluded.rejected_count,
         counts = excluded.counts,
         event_seq = excluded.event_seq,
         imported_by = excluded.imported_by,
         imported_at = now()
       returning id`,
      [
        scope.tenantId,
        scope.cnpj,
        efd.header.period,
        efd.header.kind,
        efd.header.layoutVersion,
        reference,
        efd.header.companyName,
        efd.documents.length,
        efd.rejected.length,
        JSON.stringify(efd.counts),
        eventSeq,
        importedBy,
      ],
    );

    return rows[0]!.id;
  }

  private async insertDocuments(
    client: PoolClient,
    scope: EventScope,
    spedFileId: string,
    documentos: readonly IcmsIpiDocumentSummary[],
  ): Promise<void> {
    for (let i = 0; i < documentos.length; i += LOTE) {
      const lote = documentos.slice(i, i + LOTE);
      const valores: unknown[] = [];

      const marcadores = lote.map((documento, indice) => {
        const base = indice * 11;
        valores.push(
          scope.tenantId,
          scope.cnpj,
          spedFileId,
          documento.subject,
          documento.operation,
          documento.situation,
          documento.hasItems,
          documento.hasAnalytics,
          documento.itemsIcmsCents,
          documento.analyticsIcmsCents,
          documento.documentIcmsCents,
        );
        return (
          `($${base + 1}::uuid, $${base + 2}::char(14), $${base + 3}::uuid, ` +
          `$${base + 4}, $${base + 5}, $${base + 6}::char(2), $${base + 7}, ` +
          `$${base + 8}, $${base + 9}::bigint, $${base + 10}::bigint, ` +
          `$${base + 11}::bigint)`
        );
      });

      await client.query(
        `insert into efd_icms_documents (
           tenant_id, cnpj, sped_file_id, subject, operation, situation,
           has_items, has_analytics, items_icms_cents, analytics_icms_cents,
           document_icms_cents
         ) values ${marcadores.join(', ')}`,
        valores,
      );
    }
  }

  private async upsertAssessment(
    client: PoolClient,
    scope: EventScope,
    spedFileId: string,
    efd: EfdIcmsResult,
  ): Promise<void> {
    const icms = efd.icmsAssessment;
    const ipi = efd.ipiAssessment;

    const colunas = [
      ...COLUNAS_ICMS,
      ...COLUNAS_IPI,
      'has_icms',
      'has_ipi',
    ];
    const marcadores = colunas.map((_, i) => `$${i + 4}`).join(', ');
    const atualizacoes = colunas.map((c) => `${c} = excluded.${c}`).join(', ');

    await client.query(
      `insert into efd_icms_assessments (sped_file_id, tenant_id, cnpj, ${colunas.join(', ')})
       values ($1::uuid, $2::uuid, $3::char(14), ${marcadores})
       on conflict (sped_file_id) do update set ${atualizacoes}`,
      [
        spedFileId,
        scope.tenantId,
        scope.cnpj,
        ...CAMPOS_ICMS.map((campo) => icms?.[campo] ?? null),
        ...CAMPOS_IPI.map((campo) => ipi?.[campo] ?? null),
        icms !== null,
        ipi !== null,
      ],
    );
  }

  // ------------------------------------------------------------- leitura

  async loadFile(scope: EventScope, period: string): Promise<EfdIcmsFileRow | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: 'original' | 'retificadora';
      layout_version: string;
      counts: Record<string, number>;
      imported_at: string;
    }>(
      `select id, kind, layout_version, counts, imported_at from sped_files
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
          and layout = 'icms_ipi'`,
      [scope.tenantId, scope.cnpj, period],
    );

    const linha = rows[0];
    return linha === undefined
      ? undefined
      : {
          id: linha.id,
          kind: linha.kind,
          layoutVersion: linha.layout_version,
          counts: linha.counts,
          importedAt: new Date(linha.imported_at).toISOString(),
        };
  }

  async loadDocuments(
    scope: EventScope,
    spedFileId: string,
  ): Promise<IcmsIpiDocumentSummary[]> {
    const { rows } = await this.pool.query<{
      subject: string;
      operation: 'inbound' | 'outbound';
      situation: string;
      has_items: boolean;
      has_analytics: boolean;
      items_icms_cents: string;
      analytics_icms_cents: string;
      document_icms_cents: string;
    }>(
      `select subject, operation, situation, has_items, has_analytics,
              items_icms_cents, analytics_icms_cents, document_icms_cents
         from efd_icms_documents
        where tenant_id = $1::uuid and sped_file_id = $2::uuid
        order by id`,
      [scope.tenantId, spedFileId],
    );

    return rows.map((linha) => ({
      subject: linha.subject,
      operation: linha.operation,
      situation: linha.situation,
      hasItems: linha.has_items,
      hasAnalytics: linha.has_analytics,
      itemsIcmsCents: Number(linha.items_icms_cents),
      analyticsIcmsCents: Number(linha.analytics_icms_cents),
      documentIcmsCents: Number(linha.document_icms_cents),
    }));
  }

  async loadAssessment(
    scope: EventScope,
    spedFileId: string,
  ): Promise<{ icms: EfdIcmsAssessment | null; ipi: EfdIpiAssessment | null }> {
    const { rows } = await this.pool.query<Record<string, string | boolean | null>>(
      `select * from efd_icms_assessments
        where tenant_id = $1::uuid and sped_file_id = $2::uuid`,
      [scope.tenantId, spedFileId],
    );

    const linha = rows[0];
    if (linha === undefined) {
      return { icms: null, ipi: null };
    }

    /**
     * `has_icms` e `has_ipi` decidem, e não a presença de valor: uma apuração
     * legitimamente zerada devolveria `null` se o teste fosse pelo número, e a
     * conferência diria "não deu para conferir" sobre algo que o arquivo declara.
     */
    const icms = linha['has_icms'] === true ? montar(CAMPOS_ICMS, COLUNAS_ICMS, linha) : null;
    const ipi = linha['has_ipi'] === true ? montar(CAMPOS_IPI, COLUNAS_IPI, linha) : null;

    return {
      icms: icms as EfdIcmsAssessment | null,
      ipi: ipi as EfdIpiAssessment | null,
    };
  }
}

/**
 * Campos do E110 e do E520, na ordem em que viram coluna.
 *
 * As duas listas andam em par e por isso ficam juntas: separá-las deixaria um
 * desalinhamento entre campo e coluna passar sem erro de tipo, gravando débito
 * na coluna de crédito.
 */
const CAMPOS_ICMS = [
  'totalDebitsCents',
  'documentDebitAdjustmentsCents',
  'adjustmentDebitsCents',
  'creditReversalsCents',
  'totalCreditsCents',
  'documentCreditAdjustmentsCents',
  'adjustmentCreditsCents',
  'debitReversalsCents',
  'previousCreditBalanceCents',
  'assessedBalanceCents',
  'deductionsCents',
  'icmsPayableCents',
  'carriedCreditBalanceCents',
  'extraAssessmentCents',
] as const satisfies readonly (keyof EfdIcmsAssessment)[];

const COLUNAS_ICMS = [
  'icms_total_debits_cents',
  'icms_document_debit_adjustments_cents',
  'icms_adjustment_debits_cents',
  'icms_credit_reversals_cents',
  'icms_total_credits_cents',
  'icms_document_credit_adjustments_cents',
  'icms_adjustment_credits_cents',
  'icms_debit_reversals_cents',
  'icms_previous_credit_balance_cents',
  'icms_assessed_balance_cents',
  'icms_deductions_cents',
  'icms_payable_cents',
  'icms_carried_credit_balance_cents',
  'icms_extra_assessment_cents',
] as const;

const CAMPOS_IPI = [
  'previousCreditBalanceCents',
  'debitsCents',
  'creditsCents',
  'otherDebitsCents',
  'otherCreditsCents',
  'carriedCreditBalanceCents',
  'ipiPayableCents',
] as const satisfies readonly (keyof EfdIpiAssessment)[];

const COLUNAS_IPI = [
  'ipi_previous_credit_balance_cents',
  'ipi_debits_cents',
  'ipi_credits_cents',
  'ipi_other_debits_cents',
  'ipi_other_credits_cents',
  'ipi_carried_credit_balance_cents',
  'ipi_payable_cents',
] as const;

function montar(
  campos: readonly string[],
  colunas: readonly string[],
  linha: Record<string, string | boolean | null>,
): Record<string, number> {
  const montado: Record<string, number> = {};

  campos.forEach((campo, i) => {
    const bruto = linha[colunas[i]!];
    // `bigint` chega como string no driver; `null` só quando o registro não veio.
    montado[campo] = bruto === null || bruto === undefined ? 0 : Number(bruto);
  });

  return montado;
}
