import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import type { ESAAEventData } from '../../esaa/shared/types/esaa-event.types.js';
import type { FiscalProjection } from '../shared/fiscal-projection.types.js';
import { syncPeriodState } from '../portfolio/portfolio-read-model.js';
import { AssessmentService } from './assessment.service.js';

/**
 * Confirmação da competência: o ato que a fecha (INV-001).
 *
 * Um caminho só, para a API e a CLI. A trava é o hash: confirma-se o que foi
 * conferido. Se a projeção mudou entre a conferência e a confirmação, a
 * confirmação é recusada — confirmar assim assinaria um número que ninguém viu.
 */

export class PeriodNotAssessedError extends Error {
  constructor(period: string) {
    super(`Competência ${period} não foi apurada.`);
    this.name = 'PeriodNotAssessedError';
  }
}

export interface ConfirmPeriodInput {
  pool: Pool;
  scope: EventScope;
  orchestrator: FiscalOrchestratorService;
  period: string;
  /** O hash que quem confirma conferiu. */
  projectionHash: string;
  actor: string;
  note?: string | null;
}

export interface ConfirmPeriodOutput {
  event: ESAAEventData;
  projection: FiscalProjection;
}

export async function confirmPeriod(input: ConfirmPeriodInput): Promise<ConfirmPeriodOutput> {
  const { pool, scope, orchestrator, period, projectionHash, actor } = input;

  const apuracao = await new AssessmentService(pool).find(scope, period);
  if (!apuracao) {
    throw new PeriodNotAssessedError(period);
  }

  const atual = (await orchestrator.getProjection()).projection_hash_sha256;
  if (projectionHash !== atual) {
    throw new ValidationError(
      7,
      'verification_mismatch',
      `O hash enviado não corresponde ao estado atual da competência. ` +
        `Enviado ${projectionHash.slice(0, 12)}…, atual ${atual.slice(0, 12)}…. ` +
        'Algo mudou desde a conferência: recarregue a apuração e revise antes de confirmar.',
    );
  }

  const evento = await orchestrator.processIntention({
    action: 'assessment.confirmed',
    task_id: period,
    actor,
    period,
    payload: {
      period,
      projection_hash: atual,
      total_due_cents: apuracao.total_due_cents,
      note: input.note ?? null,
    },
  });

  if (!evento.accepted) {
    throw new ValidationError(
      evento.layer ?? 4,
      'invalid_transition',
      evento.rejectionReason ?? 'Confirmação rejeitada pelo pipeline.',
    );
  }

  await syncPeriodState(pool, evento.projection!, period);
  return { event: evento.event!, projection: evento.projection! };
}
