import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import { DfeSyncRefusedError } from './dfe-errors.js';

/**
 * Coleta agendada por opt-in do cliente (ADR-007): o estado da opção, e a
 * mudança dela, que vai para o log.
 */
export interface AutoSyncState {
  enabled: boolean;
  enabled_by: string | null;
  enabled_at: string | null;
}

export async function autoSync(pool: Pool, scope: EventScope): Promise<AutoSyncState> {
  const { rows } = await pool.query<{
    dfe_auto_sync: boolean;
    dfe_auto_sync_by: string | null;
    dfe_auto_sync_at: Date | null;
  }>(
    `select dfe_auto_sync, dfe_auto_sync_by, dfe_auto_sync_at from clients
      where tenant_id = $1::uuid and cnpj = $2::char(14)`,
    [scope.tenantId, scope.cnpj],
  );
  const c = rows[0];
  return {
    enabled: c?.dfe_auto_sync ?? false,
    enabled_by: c?.dfe_auto_sync_by ?? null,
    enabled_at: c?.dfe_auto_sync_at?.toISOString() ?? null,
  };
}

/**
 * Liga ou desliga a coleta agendada. Ligar exige certificado utilizável: a
 * opção ligada sem ele só produziria jobs recusados. A mudança vai para o log
 * como `client.updated`, em nome de quem mudou — é a autorização de uso não
 * assistido do A1, e ela precisa de autor e data que não se apagam.
 */
export async function setAutoSync(
  pool: Pool,
  scope: EventScope,
  enabled: boolean,
  userId: string,
  orchestrator: FiscalOrchestratorService,
): Promise<AutoSyncState> {
  if (enabled) {
    const { rows } = await pool.query<{ credential_format: string }>(
      'select credential_format from certificates where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    if (rows.length === 0) {
      throw new DfeSyncRefusedError('Este CNPJ não tem certificado A1 guardado.', 'no_certificate');
    }
    if (rows[0]!.credential_format !== 'pem_bundle') {
      throw new DfeSyncRefusedError(
        'O certificado deste CNPJ foi guardado num formato que não abre sem a senha. ' +
          'Reenvie o certificado para ligar a coleta agendada.',
        'certificate_not_usable',
      );
    }
  }

  const r = await orchestrator.processIntention({
    action: 'client.updated',
    task_id: scope.cnpj,
    actor: userId,
    payload: { dfe_auto_sync: enabled },
  });
  if (!r.accepted) {
    throw new Error(`A mudança não foi registrada no log: ${r.rejectionReason ?? 'recusada'}.`);
  }

  await pool.query(
    `update clients
        set dfe_auto_sync = $3,
            dfe_auto_sync_by = case when $3 then $4::uuid else null end,
            dfe_auto_sync_at = case when $3 then now() else null end
      where tenant_id = $1::uuid and cnpj = $2::char(14)`,
    [scope.tenantId, scope.cnpj, enabled, userId],
  );
  return autoSync(pool, scope);
}
