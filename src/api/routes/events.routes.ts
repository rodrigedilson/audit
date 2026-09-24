import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { PostgresEventStoreRepository } from '../../infrastructure/persistence/postgres-event-store.repository.js';
import { EventReplayerService } from '../../esaa/core/event-store/event-replayer.service.js';
import { FiscalProjectorService } from '../../fiscal/projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../../fiscal/projection/fiscal-hash-verifier.service.js';
import { inferActorType } from '../actor-type.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import type { ESAAEventData } from '../../esaa/shared/types/esaa-event.types.js';

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface EventsQuery {
  after_seq?: number;
  page_size?: number;
  action?: string;
}

export async function registerEventRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get<{ Params: CnpjParams; Querystring: EventsQuery }>(
    '/clients/:cnpj/events',
    {
      schema: {
        params: CNPJ_PARAM,
        querystring: {
          type: 'object',
          properties: {
            after_seq: { type: 'integer', minimum: 0 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            action: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const pageSize = request.query.page_size ?? 50;

      const { rows } = await deps.pool.query(
        `select event_id, event_seq, ts as occurred_at, action, actor,
                cnpj, period, payload
           from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)
            and ($3::bigint is null or event_seq > $3::bigint)
            and ($4::text is null or action = $4::text)
          order by event_seq asc
          limit $5`,
        [
          scope.tenantId,
          scope.cnpj,
          request.query.after_seq ?? null,
          request.query.action ?? null,
          pageSize,
        ],
      );

      return reply.code(200).send(
        rows.map((row: Record<string, unknown>) => ({
          ...row,
          event_seq: Number(row['event_seq']),
          actor: { type: inferActorType(String(row['actor'])), id: row['actor'] },
        })),
      );
    },
  );

  /**
   * Resumo da trilha: quais ações existem neste log, e quantas.
   *
   * Existe para o filtro da trilha oferecer **só o que está no log**. A
   * alternativa era a tela listar o vocabulário fiscal inteiro — 30 ações, das
   * quais a maioria nunca ocorreu naquele CNPJ — e o contador escolher um
   * filtro que devolve vazio sem saber se é porque não houve ou porque errou.
   *
   * Também responde de relance o que aconteceu no CNPJ: 578 `doc.received` e 4
   * `output.rejected` é uma frase inteira sobre o mês.
   */
  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/events/summary',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const { rows } = await deps.pool.query<{
        action: string;
        count: string;
        last_seq: string;
        last_ts: Date;
      }>(
        `select action, count(*) as count,
                max(event_seq) as last_seq, max(ts) as last_ts
           from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)
          group by action
          order by count(*) desc, action`,
        [scope.tenantId, scope.cnpj],
      );

      return reply.code(200).send({
        actions: rows.map((row) => ({
          action: row.action,
          count: Number(row.count),
          last_seq: Number(row.last_seq),
          last_ts: row.last_ts,
        })),
        total: rows.reduce((soma, row) => soma + Number(row.count), 0),
      });
    },
  );

  /**
   * `GET /clients/{cnpj}/periods/{period}/proof` — comprovante de integridade.
   *
   * O `POST /verify` já fazia a parte difícil, mas responde sobre o CNPJ inteiro
   * e serve a quem está depurando. Este é o entregável: o documento de uma
   * competência que o escritório mostra ao cliente dele, dizendo qual número foi
   * apurado, sobre quantos documentos, e provando que a trilha fecha.
   *
   * É o precursor em JSON do Book de fechamento em PDF. Existe antes dele porque
   * a verificabilidade é o que o produto tem de diferente e não estava visível em
   * lugar nenhum — ficava atrás de um POST que ninguém chamaria por conta própria.
   */
  app.get<{ Params: CnpjParams & { period: string } }>(
    '/clients/:cnpj/periods/:period/proof',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj', 'period'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const { period } = request.params;

      const repo = new PostgresEventStoreRepository(deps.pool, scope);
      const events = await new EventReplayerService(repo).replayAll();

      const projector = new FiscalProjectorService();
      const projection = projector.project(scope.tenantId, scope.cnpj, events);
      const verificador = new FiscalHashVerifierService(projector);
      const verification = verificador.verify(events, projection);

      const competencia = projection.periods[period];
      if (!competencia) {
        throw new NotFoundError(`Competência ${period} não existe para este CNPJ.`);
      }

      const { rows: documentos } = await deps.pool.query<{ direction: string; total: string; canceladas: string }>(
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

      return reply.code(200).send({
        cnpj: scope.cnpj,
        period,
        state: competencia.state,
        verified_at: new Date().toISOString(),
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
      });
    },
  );

  /**
   * `POST /clients/{cnpj}/verify` — INV-006. Reprojeta o log do zero, de
   * propósito: é o único caminho que não confia em snapshot nenhum, e por isso o
   * único que serve como prova.
   */
  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/verify',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const repo = new PostgresEventStoreRepository(deps.pool, scope);
      const events = await new EventReplayerService(repo).replayAll();

      const projector = new FiscalProjectorService();
      const projection = projector.project(scope.tenantId, scope.cnpj, events);
      const verification = new FiscalHashVerifierService(projector).verify(events, projection);

      return reply.code(200).send({
        ok: verification.valid,
        stored_hash: verification.storedHash,
        replayed_hash: verification.replayHash,
        last_event_seq: projection.last_event_seq,
      });
    },
  );
}

/**
 * Reprojeta o log até o instante imediatamente anterior à confirmação e confere
 * se o hash then-gravado volta a sair.
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
