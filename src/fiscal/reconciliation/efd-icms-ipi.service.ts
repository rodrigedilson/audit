/**
 * Importação e conciliação da EFD ICMS/IPI.
 *
 * A conciliação **não é gravada como resultado**: é derivada do que foi
 * importado, toda vez que se pede. Congelá-la faria uma conferência nova — ou
 * uma correção numa existente — valer só para arquivo importado depois dela, e
 * o cliente continuaria vendo o veredito velho sobre o mesmo arquivo.
 *
 * O CNPJ do arquivo é conferido contra o do escopo antes de qualquer gravação:
 * importar a escrituração de um CNPJ na conta de outro produziria divergências
 * que acusam o cliente errado.
 */
import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import {
  parseEfdIcmsIpi,
  type RejectedRecord,
} from '../ingestion/efd-icms-ipi.parser.js';
import { EfdIcmsIpiRepository } from './efd-icms-ipi.repository.js';
import { reconcileIcmsIpi, type IcmsIpiReconciliation } from './icms-ipi-checks.js';

export interface EfdIcmsImportOutcome {
  sped_file_id: string;
  period: string;
  kind: 'original' | 'retificadora';
  layout_version: string;
  company_name: string;
  uf: string;
  documents_count: number;
  /** Distingue arquivo sem apuração de apuração zerada. */
  has_icms_assessment: boolean;
  has_ipi_assessment: boolean;
  rejected: RejectedRecord[];
  counts: Record<string, number>;
  event_seq: number;
  projection_hash: string;
}

export interface IcmsIpiReconciliationResult extends IcmsIpiReconciliation {
  kind: 'original' | 'retificadora';
  layout_version: string;
  imported_at: string;
}

export class EfdIcmsNotUsableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EfdIcmsNotUsableError';
  }
}

export class EfdIcmsNotImportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EfdIcmsNotImportedError';
  }
}

export class EfdIcmsIpiService {
  private readonly repository: EfdIcmsIpiRepository;

  constructor(pool: Pool) {
    this.repository = new EfdIcmsIpiRepository(pool);
  }

  async importFile(
    scope: EventScope,
    input: { content: string; reference: string },
    orchestrator: FiscalOrchestratorService,
    actor: string,
    importedBy: string | null,
  ): Promise<EfdIcmsImportOutcome> {
    const efd = parseEfdIcmsIpi(input.content);

    if (efd.header.cnpj !== scope.cnpj) {
      throw new EfdIcmsNotUsableError(
        `A escrituração é do CNPJ ${efd.header.cnpj} e está sendo enviada para ` +
          `${scope.cnpj}. Importá-la aqui produziria divergências que acusam o ` +
          'cliente errado.',
      );
    }

    const outcome = await orchestrator.processIntention({
      action: 'sped.imported',
      task_id: `efd-icms-ipi:${efd.header.period}`,
      actor,
      period: efd.header.period,
      payload: {
        layout: 'icms_ipi',
        kind: efd.header.kind,
        layout_version: efd.header.layoutVersion,
        uf: efd.header.uf,
        reference: input.reference,
        documents: efd.documents.length,
        has_icms_assessment: efd.icmsAssessment !== null,
        has_ipi_assessment: efd.ipiAssessment !== null,
        rejected: efd.rejected.length,
      },
    });

    if (!outcome.accepted) {
      throw new EfdIcmsNotUsableError(
        outcome.rejectionReason ?? 'Importação da EFD ICMS/IPI rejeitada pelo pipeline.',
      );
    }

    const eventSeq = outcome.event!.event_seq;
    const spedFileId = await this.repository.persist(
      scope,
      efd,
      input.reference,
      eventSeq,
      importedBy,
    );

    return {
      sped_file_id: spedFileId,
      period: efd.header.period,
      kind: efd.header.kind,
      layout_version: efd.header.layoutVersion,
      company_name: efd.header.companyName,
      uf: efd.header.uf,
      documents_count: efd.documents.length,
      has_icms_assessment: efd.icmsAssessment !== null,
      has_ipi_assessment: efd.ipiAssessment !== null,
      rejected: efd.rejected,
      counts: efd.counts,
      event_seq: eventSeq,
      projection_hash: outcome.projection!.projection_hash_sha256,
    };
  }

  async reconciliation(
    scope: EventScope,
    period: string,
  ): Promise<IcmsIpiReconciliationResult> {
    const cabecalho = await this.repository.loadFile(scope, period);

    if (cabecalho === undefined) {
      throw new EfdIcmsNotImportedError(
        `Nenhuma EFD ICMS/IPI importada para ${period}. A conciliação confere a ` +
          'apuração que a escrituração declarou contra os documentos dela mesma — ' +
          'sem a escrituração não há o que conferir.',
      );
    }

    const [documents, apuracao] = await Promise.all([
      this.repository.loadDocuments(scope, cabecalho.id),
      this.repository.loadAssessment(scope, cabecalho.id),
    ]);

    const conciliacao = reconcileIcmsIpi({
      period,
      documents,
      icmsAssessment: apuracao.icms,
      ipiAssessment: apuracao.ipi,
      recordCounts: cabecalho.counts,
    });

    return {
      ...conciliacao,
      kind: cabecalho.kind,
      layout_version: cabecalho.layoutVersion,
      imported_at: cabecalho.importedAt,
    };
  }
}
