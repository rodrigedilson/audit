import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import { eventoVinculado, lerEventoNfe, TP_CANCELAMENTO } from './dfe-xml.js';

/**
 * Eventos de NF-e trazidos pela distribuição (`dfe_events`) e o cancelamento
 * que eles aplicam. Ver ADR-006, seção 4.
 */
/** Motivo gravado em `dfe_events` quando o cancelamento esbarra no INV-001. */
export const CANCELAMENTO_EXIGE_RETIFICACAO = 'competência confirmada: exige retificação';

/**
 * Todo evento fica guardado, aplicado ou não. Evento ilegível não trava a
 * coleta: o NSU já avançou, e ele segue contado em `events_seen`.
 */
export async function guardarEvento(pool: Pool, scope: EventScope, nsu: string, xml: string): Promise<void> {
  let e;
  try {
    e = lerEventoNfe(xml);
  } catch {
    return;
  }
  // Evento que não vale contra a nota (136, rejeição) fica registrado já com o
  // motivo, e não é tentado.
  const motivo = eventoVinculado(e) ? null : `evento sem vínculo com a NF-e: cStat ${e.cStat ?? '?'}`;
  await pool.query(
    `insert into dfe_events (tenant_id, cnpj, access_key, tp_evento, n_seq_evento, nsu, cstat,
                             protocolo, dh_evento, xml, blocked_reason)
     values ($1::uuid, $2::char(14), $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)
     on conflict (tenant_id, cnpj, access_key, tp_evento, n_seq_evento) do update
       set cstat = coalesce(excluded.cstat, dfe_events.cstat),
           protocolo = coalesce(excluded.protocolo, dfe_events.protocolo),
           xml = case when excluded.cstat is not null then excluded.xml else dfe_events.xml end`,
    [scope.tenantId, scope.cnpj, e.accessKey, e.tpEvento, e.nSeqEvento, nsu, e.cStat, e.protocolo, e.dhEvento, xml, motivo],
  );
}

/**
 * Cancelamento homologado de nota que está na base vira `doc.cancelled`, e a
 * nota sai das somas. Competência confirmada não muda (INV-001): o evento fica
 * em `dfe_events` com o motivo, e a correção é a retificação. A checagem é
 * feita antes de propor, para não gravar um `output.rejected` a cada coleta.
 * Cancelamento de nota que ainda não chegou espera a coleta seguinte.
 */
export async function aplicarCancelamentos(
  pool: Pool,
  scope: EventScope,
  orchestrator: FiscalOrchestratorService,
  actor: string,
  resumo: { cancellations: number; cancellations_blocked: number },
): Promise<void> {
  const { rows } = await pool.query<{
    access_key: string;
    tp_evento: string;
    n_seq_evento: number;
    protocolo: string | null;
    dh_evento: Date | null;
    period: string;
    state: string | null;
  }>(
    `select e.access_key, e.tp_evento, e.n_seq_evento, e.protocolo, e.dh_evento, d.period, p.state
       from dfe_events e
       join documents d
         on d.tenant_id = e.tenant_id and d.cnpj = e.cnpj and d.access_key = e.access_key
       left join periods p
         on p.tenant_id = d.tenant_id and p.cnpj = d.cnpj and p.period = d.period
      where e.tenant_id = $1::uuid and e.cnpj = $2::char(14)
        and e.applied_at is null and e.blocked_reason is null
        and e.tp_evento = any($3::text[])
        and (e.cstat is null or e.cstat in ('135', '155'))
        and d.cancelled_at is null
      order by e.received_at`,
    [scope.tenantId, scope.cnpj, TP_CANCELAMENTO],
  );

  const aplicados = new Set<string>();
  for (const e of rows) {
    const chave = e.access_key.trim();
    // Cancelamento e cancelamento por substituição da mesma nota: um basta.
    if (aplicados.has(chave)) continue;

    if (e.state === 'confirmed') {
      await bloquearEvento(pool, scope, e, CANCELAMENTO_EXIGE_RETIFICACAO);
      resumo.cancellations_blocked += 1;
      continue;
    }

    const r = await orchestrator.processIntention({
      action: 'doc.cancelled',
      task_id: chave,
      actor,
      period: e.period,
      payload: {
        access_key: chave,
        tp_evento: e.tp_evento,
        n_seq_evento: e.n_seq_evento,
        protocol: e.protocolo,
        cancelled_at: e.dh_evento === null ? null : e.dh_evento.toISOString(),
      },
    });
    if (!r.accepted) {
      await bloquearEvento(pool, scope, e, r.rejectionReason ?? 'recusado pelo pipeline');
      resumo.cancellations_blocked += 1;
      continue;
    }

    await pool.query(
      `update documents
          set cancelled_at = coalesce($4::timestamptz, now()), cancel_protocol = $5, cancel_event_seq = $6
        where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3`,
      [scope.tenantId, scope.cnpj, chave, e.dh_evento, e.protocolo, r.event!.event_seq],
    );
    await pool.query(
      `update dfe_events set applied_at = now()
        where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3
          and tp_evento = any($4::text[]) and applied_at is null`,
      [scope.tenantId, scope.cnpj, chave, TP_CANCELAMENTO],
    );
    aplicados.add(chave);
    resumo.cancellations += 1;
  }
}

export async function bloquearEvento(
  pool: Pool,
  scope: EventScope,
  e: { access_key: string; tp_evento: string; n_seq_evento: number },
  motivo: string,
): Promise<void> {
  await pool.query(
    `update dfe_events set blocked_reason = $6
      where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3
        and tp_evento = $4 and n_seq_evento = $5`,
    [scope.tenantId, scope.cnpj, e.access_key, e.tp_evento, e.n_seq_evento, motivo],
  );
}
