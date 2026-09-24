import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { parseNfe } from '../ingestion/nfe-parser.js';

/**
 * NF-e completas trazidas pela distribuição, e a entrada delas no log.
 *
 * A nota só entra se a competência dela estiver aberta (camada 4 do pipeline).
 * A distribuição devolve os últimos 90 dias, de qualquer mês, e ingerir tudo na
 * hora gravaria um `output.rejected` permanente para cada nota de competência
 * ainda não aberta. Abrir a competência sozinho também não é uma saída: é
 * decisão do contador. A nota fica em `dfe_documents` e entra na coleta
 * seguinte à abertura.
 */

export interface IngestaoPendentes {
  ingested: number;
  rejected: number;
  alreadyPresent: number;
  awaitingPeriod: number;
}

/** Estados em que a competência aceita documento novo. */
const ABERTA = "('open', 'assessed', 'reconciled')";

export async function guardarCompletos(
  pool: Pool,
  scope: EventScope,
  documentos: { nsu: string; xml: string }[],
): Promise<string[]> {
  const chaves: string[] = [];
  for (const d of documentos) {
    let chave: string;
    let periodo: string | null;
    try {
      const nfe = parseNfe(d.xml);
      chave = nfe.accessKey;
      periodo = nfe.period;
    } catch {
      // Sem chave legível não há como guardar nem deduplicar. O NSU já avançou,
      // e o documento aparece na contagem de eventos vistos do job.
      continue;
    }
    await pool.query(
      `insert into dfe_documents (tenant_id, cnpj, access_key, nsu, period, xml)
       values ($1::uuid, $2::char(14), $3, $4, $5, $6)
       on conflict (tenant_id, cnpj, access_key) do nothing`,
      [scope.tenantId, scope.cnpj, chave, d.nsu, periodo, d.xml],
    );
    chaves.push(chave);
  }
  return chaves;
}

/**
 * Ingere o que está pendente e cuja competência está aberta. Nota que já está
 * na base (subida à mão) é marcada, e não reingerida: a duplicata viraria
 * `output.rejected` no log append-only, ruído permanente para uma situação
 * normal.
 */
export async function ingerirPendentes(
  pool: Pool,
  scope: EventScope,
  orchestrator: FiscalOrchestratorService,
  actor: string,
): Promise<IngestaoPendentes> {
  const presentes = await pool.query(
    `update dfe_documents d set ingested_at = now()
      where d.tenant_id = $1::uuid and d.cnpj = $2::char(14)
        and d.ingested_at is null and d.ingest_error is null
        and exists (select 1 from documents x
                     where x.tenant_id = d.tenant_id and x.cnpj = d.cnpj and x.access_key = d.access_key)`,
    [scope.tenantId, scope.cnpj],
  );

  const { rows } = await pool.query<{ access_key: string; xml: string }>(
    `select d.access_key, d.xml from dfe_documents d
      where d.tenant_id = $1::uuid and d.cnpj = $2::char(14)
        and d.ingested_at is null and d.ingest_error is null
        and exists (select 1 from periods p
                     where p.tenant_id = d.tenant_id and p.cnpj = d.cnpj
                       and p.period = d.period and p.state in ${ABERTA})
      order by d.nsu`,
    [scope.tenantId, scope.cnpj],
  );

  let ingested = 0;
  let rejected = 0;
  if (rows.length > 0) {
    const resultado = await new IngestionService(pool, orchestrator, scope).ingestXmlBatch(
      rows.map((r) => ({ filename: `dfe-${r.access_key.trim()}.xml`, content: r.xml })),
      actor,
    );
    for (const a of resultado.accepted) {
      await pool.query(
        `update dfe_documents set ingested_at = now()
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3`,
        [scope.tenantId, scope.cnpj, a.access_key],
      );
    }
    for (const r of resultado.rejected) {
      if (r.access_key === undefined) continue;
      await pool.query(
        `update dfe_documents set ingest_error = $4
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3`,
        [scope.tenantId, scope.cnpj, r.access_key, r.message],
      );
    }
    ingested = resultado.accepted.length;
    rejected = resultado.rejected.length;
  }

  const { rows: espera } = await pool.query<{ n: string }>(
    `select count(*)::text n from dfe_documents
      where tenant_id = $1::uuid and cnpj = $2::char(14) and ingested_at is null and ingest_error is null`,
    [scope.tenantId, scope.cnpj],
  );

  return {
    ingested,
    rejected,
    alreadyPresent: presentes.rowCount ?? 0,
    awaitingPeriod: Number(espera[0]!.n),
  };
}
