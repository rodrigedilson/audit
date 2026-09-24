import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import {
  parseSped,
  type RejectedRecord,
  type SpedCarriedCredit,
  type SpedDocument,
  type SpedResult,
} from './sped-parser.js';
import {
  buildDossier,
  type CoverageWindow,
  type DossierResult,
  type OwnDocument,
} from './credit-backing.js';

export interface SpedImportOutcome {
  sped_file_id: string;
  period: string;
  kind: 'original' | 'retificadora';
  layout_version: string;
  company_name: string;
  documents_count: number;
  carried_credits_count: number;
  rejected: RejectedRecord[];
  counts: Record<string, number>;
  event_seq: number;
  projection_hash: string;
}

export interface Dossier extends DossierResult {
  period: string;
  kind: 'original' | 'retificadora';
  imported_at: string;
  coverage: { from: string | null; to: string | null; periods: string[] };
}

export class SpedNotUsableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpedNotUsableError';
  }
}

export class DossierNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierNotReadyError';
  }
}

/**
 * Dossiê de saldo credor PIS/Cofins — diferencial #9.
 *
 * O dossiê **não é gravado como resultado**: é derivado da EFD importada mais a
 * base de documentos de agora. Congelá-lo esconderia o ganho de lastro que
 * acontece quando o escritório localiza um XML que faltava — e localizar
 * documento é justamente o trabalho que o dossiê encomenda.
 *
 * O CNPJ do arquivo é conferido contra o do escopo antes de qualquer gravação:
 * importar a EFD de um CNPJ na conta de outro produziria um dossiê que acusa o
 * cliente errado.
 */
export class DossierService {
  constructor(private readonly pool: Pool) {}

  async importSped(
    scope: EventScope,
    input: { content: string; reference: string },
    orchestrator: FiscalOrchestratorService,
    actor: string,
    importedBy: string | null,
  ): Promise<SpedImportOutcome> {
    const sped = parseSped(input.content);

    if (sped.header.cnpj !== scope.cnpj) {
      throw new SpedNotUsableError(
        `A escrituração é do CNPJ ${sped.header.cnpj} e está sendo enviada para ` +
          `${scope.cnpj}. Importá-la aqui produziria um dossiê que acusa o cliente errado.`,
      );
    }

    const outcome = await orchestrator.processIntention({
      action: 'sped.imported',
      task_id: `sped:${sped.header.period}`,
      actor,
      period: sped.header.period,
      payload: {
        kind: sped.header.kind,
        layout_version: sped.header.layoutVersion,
        reference: input.reference,
        documents: sped.documents.length,
        carried_credits: sped.carriedCredits.length,
        apured_credits: sped.apuredCredits.length,
        rejected: sped.rejected.length,
      },
    });

    if (!outcome.accepted) {
      throw new SpedNotUsableError(
        outcome.rejectionReason ?? 'Importação do SPED rejeitada pelo pipeline.',
      );
    }

    const eventSeq = outcome.event!.event_seq;
    const spedFileId = await this.persist(scope, sped, input.reference, eventSeq, importedBy);

    return {
      sped_file_id: spedFileId,
      period: sped.header.period,
      kind: sped.header.kind,
      layout_version: sped.header.layoutVersion,
      company_name: sped.header.companyName,
      documents_count: sped.documents.length,
      carried_credits_count: sped.carriedCredits.length,
      rejected: sped.rejected,
      counts: sped.counts,
      event_seq: eventSeq,
      projection_hash: outcome.projection!.projection_hash_sha256,
    };
  }

  async dossier(scope: EventScope, period: string): Promise<Dossier> {
    const cabecalho = await this.loadSpedFile(scope, period);

    if (cabecalho === undefined) {
      throw new DossierNotReadyError(
        `Nenhuma EFD-Contribuições importada para ${period}. O dossiê confere o que a ` +
          'escrituração declarou contra os documentos da base — sem a escrituração não ' +
          'há o que conferir.',
      );
    }

    const [spedDocuments, carriedCredits, ownDocuments, coverage] = await Promise.all([
      this.loadSpedDocuments(scope, cabecalho.id),
      this.loadCarriedCredits(scope, cabecalho.id),
      this.loadOwnDocuments(scope),
      this.loadCoverage(scope),
    ]);

    const resultado = buildDossier({
      spedDocuments,
      carriedCredits,
      ownDocuments,
      coverage,
      period,
    });

    return {
      ...resultado,
      period,
      kind: cabecalho.kind,
      imported_at: cabecalho.importedAt,
      coverage: {
        from: coverage.from,
        to: coverage.to,
        periods: [...coverage.periods].sort(),
      },
    };
  }

  // ------------------------------------------------------- persistência

  private async persist(
    scope: EventScope,
    sped: SpedResult,
    reference: string,
    eventSeq: number,
    importedBy: string | null,
  ): Promise<string> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      /**
       * A retificadora substitui a original, como na própria EFD. Manter as duas
       * daria dois saldos credores para o mesmo mês, e nenhum defensável.
       */
      const { rows } = await client.query<{ id: string }>(
        `insert into sped_files (
           tenant_id, cnpj, period, layout, kind, layout_version, reference,
           company_name, documents_count, rejected_count, counts, event_seq,
           imported_by, imported_at
         ) values ($1::uuid, $2::char(14), $3::char(7), 'contribuicoes',
                   $4::sped_kind, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::uuid, now())
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
          sped.header.period,
          sped.header.kind,
          sped.header.layoutVersion,
          reference,
          sped.header.companyName,
          sped.documents.length,
          sped.rejected.length,
          JSON.stringify(sped.counts),
          eventSeq,
          importedBy,
        ],
      );

      const spedFileId = rows[0]!.id;

      // Substitui por inteiro: o `on conflict` acima reaproveita o id, então as
      // linhas da importação anterior sairiam misturadas com as novas.
      await client.query('delete from sped_documents where sped_file_id = $1::uuid', [
        spedFileId,
      ]);
      await client.query('delete from sped_carried_credits where sped_file_id = $1::uuid', [
        spedFileId,
      ]);

      for (const documento of sped.documents) {
        const somas = documento.items.reduce(
          (soma, item) => ({
            pis: soma.pis + item.pis.amountCents,
            cofins: soma.cofins + item.cofins.amountCents,
          }),
          { pis: 0, cofins: 0 },
        );

        await client.query(
          `insert into sped_documents (
             tenant_id, cnpj, sped_file_id, operation, model, access_key,
             document_number, issued_at, total_cents, pis_cents, cofins_cents
           ) values ($1::uuid, $2::char(14), $3::uuid, $4, $5, $6::char(44),
                     $7, $8::date, $9, $10, $11)`,
          [
            scope.tenantId,
            scope.cnpj,
            spedFileId,
            documento.operation,
            documento.model,
            documento.accessKey,
            documento.documentNumber,
            documento.issuedAt,
            documento.totalCents,
            somas.pis,
            somas.cofins,
          ],
        );
      }

      for (const credito of sped.carriedCredits) {
        await client.query(
          `insert into sped_carried_credits (
             tenant_id, cnpj, sped_file_id, tax, origin_period, credit_code, origin,
             apured_cents, available_cents, used_cents, refunded_cents, final_balance_cents
           ) values ($1::uuid, $2::char(14), $3::uuid, $4, $5::char(7), $6, $7,
                     $8, $9, $10, $11, $12)`,
          [
            scope.tenantId,
            scope.cnpj,
            spedFileId,
            credito.tax,
            credito.originPeriod,
            credito.creditCode,
            credito.origin,
            credito.apuredCents,
            credito.availableCents,
            credito.usedCents,
            credito.refundedCents,
            credito.finalBalanceCents,
          ],
        );
      }

      await client.query('commit');
      return spedFileId;
    } catch (causa) {
      await client.query('rollback');
      throw causa;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------ leitura

  private async loadSpedFile(
    scope: EventScope,
    period: string,
  ): Promise<{ id: string; kind: 'original' | 'retificadora'; importedAt: string } | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: 'original' | 'retificadora';
      imported_at: string;
    }>(
      `select id, kind, imported_at from sped_files
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
          and layout = 'contribuicoes'`,
      [scope.tenantId, scope.cnpj, period],
    );

    const linha = rows[0];
    return linha === undefined
      ? undefined
      : {
          id: linha.id,
          kind: linha.kind,
          importedAt: new Date(linha.imported_at).toISOString(),
        };
  }

  /**
   * Os documentos da EFD voltam com os itens já somados.
   *
   * `buildDossier` espera itens, e reconstruí-los seria carregar linha a linha
   * de volta sem necessidade: um item sintético com as somas dá exatamente a
   * mesma conferência, que é por documento.
   */
  private async loadSpedDocuments(
    scope: EventScope,
    spedFileId: string,
  ): Promise<SpedDocument[]> {
    const { rows } = await this.pool.query<{
      operation: string;
      model: string;
      access_key: string | null;
      document_number: string | null;
      issued_at: string | null;
      total_cents: string;
      pis_cents: string;
      cofins_cents: string;
    }>(
      `select operation, model, access_key, document_number, issued_at,
              total_cents, pis_cents, cofins_cents
         from sped_documents
        where tenant_id = $1::uuid and sped_file_id = $2::uuid
        order by id`,
      [scope.tenantId, spedFileId],
    );

    return rows.map((r, indice) => ({
      line: indice + 1,
      operation: r.operation === 'outbound' ? 'outbound' : 'inbound',
      model: r.model,
      accessKey: r.access_key === null ? null : String(r.access_key).trim(),
      documentNumber: r.document_number,
      issuedAt: r.issued_at === null ? null : new Date(r.issued_at).toISOString().slice(0, 10),
      totalCents: Number(r.total_cents),
      items: [
        {
          itemNumber: 1,
          code: '',
          cfop: '',
          totalCents: Number(r.total_cents),
          pis: { cst: '', baseCents: 0, rate: 0, amountCents: Number(r.pis_cents) },
          cofins: { cst: '', baseCents: 0, rate: 0, amountCents: Number(r.cofins_cents) },
        },
      ],
    }));
  }

  private async loadCarriedCredits(
    scope: EventScope,
    spedFileId: string,
  ): Promise<SpedCarriedCredit[]> {
    const { rows } = await this.pool.query<{
      tax: string;
      origin_period: string;
      credit_code: string;
      origin: string;
      apured_cents: string;
      available_cents: string;
      used_cents: string;
      refunded_cents: string;
      final_balance_cents: string;
    }>(
      `select tax, origin_period, credit_code, origin, apured_cents, available_cents,
              used_cents, refunded_cents, final_balance_cents
         from sped_carried_credits
        where tenant_id = $1::uuid and sped_file_id = $2::uuid
        order by tax, origin_period`,
      [scope.tenantId, spedFileId],
    );

    return rows.map((r) => ({
      tax: r.tax === 'cofins' ? 'cofins' : 'pis',
      originPeriod: String(r.origin_period).trim(),
      creditCode: r.credit_code,
      origin: r.origin,
      apuredCents: Number(r.apured_cents),
      availableCents: Number(r.available_cents),
      usedCents: Number(r.used_cents),
      refundedCents: Number(r.refunded_cents),
      finalBalanceCents: Number(r.final_balance_cents),
    }));
  }

  /**
   * Documentos da nossa base, com PIS e Cofins somados dos itens.
   *
   * Só entrada: o crédito nasce da aquisição, e trazer a saída faria o dossiê
   * conferir o débito do cliente como se fosse crédito.
   */
  private async loadOwnDocuments(scope: EventScope): Promise<OwnDocument[]> {
    const { rows } = await this.pool.query<{
      access_key: string;
      period: string;
      pis: string;
      cofins: string;
    }>(
      `select d.access_key, d.period,
              coalesce(sum((i.legacy_taxes->'pis'->>'amountCents')::bigint), 0)::text as pis,
              coalesce(sum((i.legacy_taxes->'cofins'->>'amountCents')::bigint), 0)::text as cofins
         from documents d
         join document_items i
           on i.tenant_id = d.tenant_id and i.cnpj = d.cnpj and i.access_key = d.access_key
        where d.tenant_id = $1::uuid and d.cnpj = $2::char(14) and d.direction = 'inbound'
        group by d.access_key, d.period`,
      [scope.tenantId, scope.cnpj],
    );

    return rows.map((r) => ({
      accessKey: String(r.access_key).trim(),
      period: String(r.period).trim(),
      pisCents: Number(r.pis),
      cofinsCents: Number(r.cofins),
    }));
  }

  private async loadCoverage(scope: EventScope): Promise<CoverageWindow> {
    const { rows } = await this.pool.query<{ period: string }>(
      'select period from document_coverage($1::uuid, $2::char(14))',
      [scope.tenantId, scope.cnpj],
    );

    const periodos = rows.map((r) => String(r.period).trim()).sort();

    return {
      periods: new Set(periodos),
      from: periodos[0] ?? null,
      to: periodos.at(-1) ?? null,
    };
  }
}
