import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { ESAAEventData } from '../../esaa/shared/types/esaa-event.types.js';
import { PostgresEventStoreRepository } from '../../infrastructure/persistence/postgres-event-store.repository.js';
import { EventReplayerService } from '../../esaa/core/event-store/event-replayer.service.js';
import { FiscalProjectorService } from '../projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../projection/fiscal-hash-verifier.service.js';
import type { PeriodState } from '../shared/fiscal-vocabulary.js';

/**
 * Comprovante de integridade de uma competência: qual número foi apurado, sobre
 * quantos documentos, e a prova de que a trilha fecha. Saiu da rota para o JSON
 * e o PDF serem a mesma conta — dois cálculos acabariam divergindo.
 */

export class ProofPeriodNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofPeriodNotFoundError';
  }
}

export interface IntegrityProof {
  cnpj: string;
  period: string;
  state: PeriodState;
  verified_at: string;
  /** `false`: a projeção não fecha com o log. O comprovante sai com o defeito à mostra. */
  ok: boolean;
  replayed_hash: string;
  stored_hash: string;
  /** Hash gravado no ato da confirmação, preservado mesmo depois de retificação (INV-001). */
  confirmed_hash: string | null;
  /**
   * A prova mais forte: o hash da confirmação reproduzido replayando só os
   * eventos anteriores a ela. `null` em competência não confirmada.
   */
  confirmed_hash_reproduced: boolean | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  rectifies: string | null;
  rectified_by: string | null;
  last_event_seq: number;
  events_in_period: number;
  total_events: number;
  documents: { inbound: number; outbound: number; total: number; cancelled: number };
}

export class IntegrityProofService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async build(scope: EventScope, period: string): Promise<IntegrityProof> {
    const repo = new PostgresEventStoreRepository(this.pool, scope);
    const events = await new EventReplayerService(repo).replayAll();

    const projector = new FiscalProjectorService();
    const projection = projector.project(scope.tenantId, scope.cnpj, events);
    const verificador = new FiscalHashVerifierService(projector);
    const verification = verificador.verify(events, projection);

    const competencia = projection.periods[period];
    if (!competencia) {
      throw new ProofPeriodNotFoundError(`Competência ${period} não existe para este CNPJ.`);
    }

    const { rows: documentos } = await this.pool.query<{ direction: string; total: string; canceladas: string }>(
      `select direction, count(*) filter (where cancelled_at is null) as total,
              count(*) filter (where cancelled_at is not null) as canceladas
         from documents
        where tenant_id = $1::uuid and cnpj = $2 and period = $3::char(7)
        group by direction`,
      [scope.tenantId, scope.cnpj, period],
    );

    const porDirecao = new Map(documentos.map((row) => [row.direction, Number(row.total)]));
    const canceladas = documentos.reduce((soma, row) => soma + Number(row.canceladas), 0);

    // Eventos da competência: é o que liga o hash ao trabalho feito no mês.
    const eventosDaCompetencia = events.filter((evento) => evento.period === period);

    const confirmacao = reproduzirHashDaConfirmacao(events, period, projector, verificador);

    return {
      cnpj: scope.cnpj,
      period,
      state: competencia.state,
      verified_at: this.now().toISOString(),
      /**
       * `ok: false` significa que a projeção não fecha com o event log. O
       * comprovante ainda é emitido, e com o defeito à mostra: esconder a
       * divergência seria o oposto do que o documento existe para fazer.
       */
      ok: verification.valid,
      replayed_hash: verification.replayHash,
      stored_hash: verification.storedHash,
      /**
       * Hash gravado no ato da confirmação. Preservado mesmo depois de uma
       * retificação, que abre competência vinculada em vez de reabrir esta
       * (INV-001) — é o que permite defender o número já entregue.
       */
      confirmed_hash: competencia.projection_hash ?? null,
      /**
       * A prova mais forte que o comprovante carrega.
       *
       * `ok` compara a projeção de agora consigo mesma e com o replay — pega
       * projetor não-determinístico, mas não pega evento adulterado, porque os
       * dois lados saem dos mesmos eventos. Aqui é diferente: o hash foi
       * gravado no log no ato da confirmação, e reproduzi-lo exige replayar os
       * eventos **anteriores** àquele instante. Se alguém alterou, removeu ou
       * acrescentou evento no meio do caminho, o número não volta a bater.
       *
       * `null` em competência ainda não confirmada — não há o que reproduzir.
       */
      confirmed_hash_reproduced: confirmacao,
      confirmed_at: competencia.confirmed_at ?? null,
      confirmed_by: competencia.confirmed_by ?? null,
      rectifies: competencia.rectifies ?? null,
      rectified_by: competencia.rectified_by ?? null,
      last_event_seq: projection.last_event_seq,
      events_in_period: eventosDaCompetencia.length,
      total_events: verification.eventCount,
      documents: {
        inbound: porDirecao.get('inbound') ?? 0,
        outbound: porDirecao.get('outbound') ?? 0,
        total: [...porDirecao.values()].reduce((soma, n) => soma + n, 0),
        // Canceladas na SEFAZ: ficam na base e fora das somas, e aparecem à
        // parte para o total bater com o que foi recebido.
        cancelled: canceladas,
      },
    };
  }
}

/**
 * Reprojeta o log até o instante imediatamente anterior à confirmação e confere
 * se o hash gravado naquele momento volta a sair.
 *
 * O corte é **antes** do evento de confirmação de propósito: o hash que o
 * contador aprovou é o da projeção que ele viu, e essa projeção ainda não
 * continha o próprio ato de confirmar.
 */
function reproduzirHashDaConfirmacao(
  events: readonly ESAAEventData[],
  period: string,
  projector: FiscalProjectorService,
  verificador: FiscalHashVerifierService,
): boolean | null {
  const indice = events.findIndex(
    (evento) =>
      evento.action === 'assessment.confirmed' &&
      ((evento.payload as { period?: string }).period ?? evento.period) === period,
  );
  if (indice === -1) {
    return null;
  }

  const confirmado = (events[indice]!.payload as { projection_hash?: string }).projection_hash;
  if (!confirmado) {
    return null;
  }

  const anteriores = events.slice(0, indice);
  const naEpoca = projector.project(
    events[indice]!.tenant_id,
    events[indice]!.cnpj,
    anteriores,
  );

  return verificador.computeHash(naEpoca) === confirmado;
}
