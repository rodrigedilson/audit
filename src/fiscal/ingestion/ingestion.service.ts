import type { Pool } from 'pg';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import { DocumentParseError, parseNfe, type ParsedDocument } from './nfe-parser.js';
import { CatalogService } from '../catalog/catalog.service.js';

export interface AcceptedDocument {
  access_key: string;
  model: string;
  direction: 'inbound' | 'outbound';
  period: string;
  event_id: string;
  event_seq: number;
  projection_hash: string;
}

export interface RejectedDocument {
  rejected: true;
  filename: string;
  layer: number;
  reason: string;
  message: string;
  access_key?: string;
}

export interface IngestionResult {
  accepted: AcceptedDocument[];
  rejected: RejectedDocument[];
}

export interface UploadedFile {
  filename: string;
  content: string;
}

/**
 * Ingestão de documentos fiscais.
 *
 * Um arquivo rejeitado **não** interrompe o lote: o escritório sobe o mês
 * inteiro de uma vez, e uma nota com problema não pode impedir as outras de
 * entrarem. Cada rejeição vira `output.rejected` no log, com camada e motivo —
 * é o que transforma "erro no upload" em inconsistência fiscal auditável.
 */
export class IngestionService {
  constructor(
    private readonly pool: Pool,
    private readonly orchestrator: FiscalOrchestratorService,
    private readonly scope: EventScope,
  ) {}

  async ingestXmlBatch(files: readonly UploadedFile[], actor: string): Promise<IngestionResult> {
    const result: IngestionResult = { accepted: [], rejected: [] };

    for (const file of files) {
      try {
        result.accepted.push(await this.ingestOne(file, actor));
      } catch (error) {
        result.rejected.push(await this.rejectOne(file, error, actor));
      }
    }

    return result;
  }

  private async ingestOne(file: UploadedFile, actor: string): Promise<AcceptedDocument> {
    const parsed = parseNfe(file.content);
    const direction = this.directionOf(parsed);

    // Duplicata é decidida pela constraint da tabela, não por um SELECT antes
    // do INSERT: entre a checagem e a escrita cabe outro upload do mesmo lote.
    if (await this.alreadyReceived(parsed.accessKey)) {
      throw new DocumentParseError(
        'duplicate_document',
        2,
        `Documento ${parsed.accessKey} já foi recebido para este CNPJ.`,
      );
    }

    const outcome = await this.orchestrator.processIntention({
      action: 'doc.received',
      task_id: parsed.accessKey,
      actor,
      period: parsed.period,
      payload: {
        access_key: parsed.accessKey,
        model: parsed.model,
        direction,
        series: parsed.series,
        number: parsed.number,
        issued_at: parsed.issuedAt,
        issuer_cnpj: parsed.issuerCnpj,
        issuer_name: parsed.issuerName,
        recipient_cnpj: parsed.recipientCnpj ?? null,
        total_cents: parsed.totalCents,
        item_count: parsed.items.length,
        has_reform_group: parsed.hasReformGroup,
      },
    });

    if (!outcome.accepted) {
      throw new DocumentParseError(
        'schema_violation',
        (outcome.layer ?? 2) as 1 | 2,
        outcome.rejectionReason ?? 'Documento rejeitado pelo pipeline.',
      );
    }

    await this.saveReadModel(parsed, direction, outcome.event!.event_seq);

    // Registra os itens vistos, para a saúde do cadastro priorizar o que está
    // em uso: item que não aparece num documento há meses não merece a mesma
    // atenção de um que está em toda nota.
    await new CatalogService(this.pool).touchItems(this.scope, parsed.items);

    return {
      access_key: parsed.accessKey,
      model: parsed.model,
      direction,
      period: parsed.period,
      event_id: outcome.event!.event_id,
      event_seq: outcome.event!.event_seq,
      projection_hash: outcome.projection!.projection_hash_sha256,
    };
  }

  /**
   * Registra a rejeição no log e devolve a linha do `rejected[]` da resposta
   * 207. Gravar a rejeição é o ponto: sem isso, o contador não tem como provar
   * depois que aquele documento chegou e foi recusado, nem por quê.
   */
  private async rejectOne(
    file: UploadedFile,
    error: unknown,
    actor: string,
  ): Promise<RejectedDocument> {
    const failure =
      error instanceof DocumentParseError
        ? error
        : new DocumentParseError('schema_violation', 1, describe(error));

    const accessKey = tryReadAccessKey(failure.message);

    // A competência vem da chave de acesso (posições 3-6, AAMM), porque é o
    // único lugar onde ela sobrevive a um documento que não pôde ser lido. Sem
    // isso a rejeição fica sem competência e nunca aparece no Book de nenhum
    // mês — a inconsistência existiria no log e não seria reportada a ninguém.
    const period = accessKey === undefined ? undefined : periodFromAccessKey(accessKey);

    await this.orchestrator.processIntention({
      action: 'output.rejected',
      task_id: accessKey ?? file.filename,
      actor,
      ...(period === undefined ? {} : { period }),
      payload: {
        reason: failure.reason,
        details: failure.message,
        original_action: 'doc.received',
        validation_layer: failure.layer,
        filename: file.filename,
      },
    });

    return {
      rejected: true,
      filename: file.filename,
      layer: failure.layer,
      reason: failure.reason,
      message: failure.message,
      ...(accessKey === undefined ? {} : { access_key: accessKey }),
    };
  }

  /**
   * Entrada ou saída pela ótica do CNPJ do escopo. Um mesmo XML é saída para
   * quem emitiu e entrada para quem recebeu, e a apuração trata os dois de
   * formas opostas: um gera débito, o outro crédito.
   */
  private directionOf(parsed: ParsedDocument): 'inbound' | 'outbound' {
    return parsed.issuerCnpj === this.scope.cnpj ? 'outbound' : 'inbound';
  }

  private async alreadyReceived(accessKey: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `select 1 from documents
        where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3::char(44)`,
      [this.scope.tenantId, this.scope.cnpj, accessKey],
    );
    return rows.length > 0;
  }

  private async saveReadModel(
    parsed: ParsedDocument,
    direction: 'inbound' | 'outbound',
    eventSeq: number,
  ): Promise<void> {
    const counterpartyCnpj =
      direction === 'outbound' ? (parsed.recipientCnpj ?? null) : parsed.issuerCnpj;
    const counterpartyName =
      direction === 'outbound' ? (parsed.recipientName ?? null) : parsed.issuerName;

    await this.pool.query(
      `insert into documents (
         tenant_id, cnpj, access_key, model, direction, series, number, issued_at, period,
         issuer_cnpj, issuer_name, counterparty_cnpj, counterparty_name,
         total_cents, has_reform_group, event_seq
       ) values ($1::uuid, $2::char(14), $3::char(44), $4, $5, $6, $7, $8::timestamptz, $9::char(7),
                 $10::char(14), $11, $12, $13, $14, $15, $16)
       on conflict (tenant_id, cnpj, access_key) do nothing`,
      [
        this.scope.tenantId,
        this.scope.cnpj,
        parsed.accessKey,
        parsed.model,
        direction,
        parsed.series,
        parsed.number,
        parsed.issuedAt,
        parsed.period,
        parsed.issuerCnpj,
        parsed.issuerName,
        counterpartyCnpj,
        counterpartyName,
        parsed.totalCents,
        parsed.hasReformGroup,
        eventSeq,
      ],
    );

    for (const item of parsed.items) {
      await this.pool.query(
        `insert into document_items (
           tenant_id, cnpj, access_key, line, code, description, ncm, cfop, unit,
           quantity, unit_price_cents, total_cents, legacy_taxes, reform_taxes
         ) values ($1::uuid, $2::char(14), $3::char(44), $4, $5, $6, $7, $8, $9,
                   $10, $11, $12, $13::jsonb, $14::jsonb)
         on conflict (tenant_id, cnpj, access_key, line) do nothing`,
        [
          this.scope.tenantId,
          this.scope.cnpj,
          parsed.accessKey,
          item.line,
          item.code,
          item.description,
          item.ncm,
          item.cfop,
          item.unit,
          item.quantity,
          item.unitPriceCents,
          item.totalCents,
          JSON.stringify(item.legacy),
          item.reform === undefined ? null : JSON.stringify(item.reform),
        ],
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Recupera a chave da mensagem de erro, quando a rejeição a menciona. */
function tryReadAccessKey(message: string): string | undefined {
  return /\b([0-9]{44})\b/.exec(message)?.[1];
}

/**
 * Competência codificada na chave de acesso: cUF(2) + AAMM(4) + ...
 *
 * Difere de propósito do caminho do documento aceito, que usa a `dhEmi`: num
 * documento recusado a `dhEmi` pode ser justamente o campo inválido, enquanto o
 * AAMM da chave já passou pelo dígito verificador.
 */
export function periodFromAccessKey(accessKey: string): string | undefined {
  const aamm = /^[0-9]{2}([0-9]{2})(0[1-9]|1[0-2])/.exec(accessKey);
  if (!aamm) {
    return undefined;
  }
  return `20${aamm[1]}-${aamm[2]}`;
}
