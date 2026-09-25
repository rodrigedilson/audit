import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { AssessmentService } from '../../fiscal/assessment/assessment.service.js';
import { syncPeriodState } from '../../fiscal/portfolio/portfolio-read-model.js';
import { PeriodNotAssessedError, confirmPeriod } from '../../fiscal/assessment/period-confirmation.service.js';
import type { Regime } from '../../fiscal/shared/fiscal-vocabulary.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';
import { PADRAO_DA_CHAVE } from '../../fiscal/ingestion/access-key.js';

const PERIOD = '^[0-9]{4}-(0[1-9]|1[0-2])$';

const SCOPE_PARAMS = {
  type: 'object',
  required: ['cnpj', 'period'],
  properties: {
    cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
    period: { type: 'string', pattern: PERIOD },
  },
} as const;

interface ScopeParams {
  cnpj: string;
  period: string;
}

/**
 * Apuração dual — diferencial #2.
 *
 * Toda resposta de leitura traz o `projection_hash`, e o `confirm` exige de
 * volta o hash que o usuário viu na tela. É o que impede confirmar uma apuração
 * que mudou entre a conferência e o clique.
 */
export async function registerAssessmentRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const assessment = new AssessmentService(deps.pool);

  const regimeDoCliente = async (tenantId: string, cnpj: string): Promise<Regime> => {
    const { rows } = await deps.pool.query<{ regime: Regime }>(
      'select regime from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [tenantId, cnpj],
    );
    const regime = rows[0]?.regime;
    if (!regime) {
      throw new NotFoundError(`CNPJ ${cnpj} não encontrado nesta carteira.`);
    }
    return regime;
  };

  app.get<{ Params: ScopeParams }>(
    '/clients/:cnpj/assessments/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const apuracao = await assessment.find(scope, request.params.period);

      if (!apuracao) {
        throw new NotFoundError(
          `Competência ${request.params.period} não foi apurada. ` +
            'Use POST na mesma rota para projetar a apuração.',
        );
      }

      /**
       * `is_current` diz se o `projection_hash` guardado ainda vale.
       *
       * O hash da apuração é o de quando ela foi calculada; o `confirm` compara
       * com o hash **atual** do log. Qualquer evento posterior — um ajuste, um
       * documento novo — deixa o guardado velho, e a tela enviava um hash
       * inevitavelmente recusado com `verification_mismatch`. O contador lia
       * isso como defeito do sistema, porque nada na tela dizia que a apuração
       * tinha ficado para trás.
       *
       * Só o booleano, e **não** o hash atual: expor o hash novo convidaria a
       * tela a reenviá-lo, que é exatamente o que anularia a proteção. Quando
       * `is_current` é falso, o caminho é reprojetar e revisar.
       */
      const orchestrator = await deps.orchestratorFor(scope);
      const atual = (await orchestrator.getProjection()).projection_hash_sha256;

      return reply.code(200).send({ ...apuracao, is_current: apuracao.projection_hash === atual });
    },
  );

  /**
   * (Re)projeta a apuração. Emite `assessment.projected`, que move a
   * competência de `open` para `assessed` — a camada 4 valida a transição.
   */
  app.post<{ Params: ScopeParams }>(
    '/clients/:cnpj/assessments/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { period } = request.params;
      const regime = await regimeDoCliente(scope.tenantId, scope.cnpj);

      const resultado = await assessment.computeFor(scope, period, regime);
      const devido = assessment.totalDueOf(resultado);

      const orchestrator = await deps.orchestratorFor(scope);
      const evento = await orchestrator.processIntention({
        action: 'assessment.projected',
        task_id: period,
        actor: context.user.userId,
        period,
        payload: {
          period,
          regime,
          documents: resultado.documentsConsidered,
          items: resultado.itemsConsidered,
          total_due_cents: devido,
          not_computable: resultado.notComputable.length,
          coverage: resultado.coverage,
        },
      });

      if (!evento.accepted) {
        throw new ValidationError(
          evento.layer ?? 4,
          'invalid_transition',
          evento.rejectionReason ?? 'Apuração rejeitada pelo pipeline.',
        );
      }

      const hash = evento.projection!.projection_hash_sha256;
      await assessment.save(scope, resultado, hash, evento.event!.event_seq);
      // A apuração moveu a competência no log; o read model que a carteira lê
      // precisa acompanhar, senão ela mostra `open` num mês já apurado.
      await syncPeriodState(deps.pool, evento.projection!, period);

      return reply.code(200).send({
        event_id: evento.event!.event_id,
        event_seq: evento.event!.event_seq,
        action: evento.event!.action,
        projection_hash: hash,
        period,
        regime,
        totals: { ...resultado.legacy, ...resultado.reform },
        total_due_cents: devido,
        not_computable: resultado.notComputable,
        coverage: resultado.coverage,
        documents_count: resultado.documentsConsidered,
        items_count: resultado.itemsConsidered,
        trace_lines: resultado.trace.length,
      });
    },
  );

  /** Memória de cálculo, nota a nota. É o que o contador apresenta. */
  app.get<{ Params: ScopeParams; Querystring: { tax?: string; access_key?: string } }>(
    '/clients/:cnpj/assessments/:period/trace',
    {
      schema: {
        params: SCOPE_PARAMS,
        querystring: {
          type: 'object',
          properties: {
            tax: { type: 'string' },
            access_key: { type: 'string', pattern: PADRAO_DA_CHAVE },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const filtro: { tax?: string; accessKey?: string } = {};
      if (request.query.tax !== undefined) filtro.tax = request.query.tax;
      if (request.query.access_key !== undefined) filtro.accessKey = request.query.access_key;

      const linhas = await assessment.trace(scope, request.params.period, filtro);

      return reply.code(200).send({ items: linhas, total: linhas.length });
    },
  );

  /**
   * Ajuste manual justificado. Emite `assessment.adjusted`, que devolve a
   * competência de `reconciled` para `assessed` — ajustar reabre a conciliação.
   *
   * Não sobrescreve a apuração: entra como linha própria, para a diferença entre
   * o apurado e o ajustado ficar visível.
   */
  app.post<{
    Params: ScopeParams;
    Body: { tax: string; amount_cents: number; reason: string; reference_access_key?: string };
  }>(
    '/clients/:cnpj/assessments/:period/adjustments',
    {
      schema: {
        params: SCOPE_PARAMS,
        body: {
          type: 'object',
          required: ['tax', 'amount_cents', 'reason'],
          properties: {
            tax: {
              type: 'string',
              enum: ['icms', 'ipi', 'pis', 'cofins', 'ibs_uf', 'ibs_mun', 'cbs'],
            },
            amount_cents: { type: 'integer' },
            reason: { type: 'string', minLength: 3, maxLength: 1000 },
            reference_access_key: { type: 'string', pattern: PADRAO_DA_CHAVE },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { period } = request.params;

      if (!(await assessment.find(scope, period))) {
        throw new NotFoundError(
          `Competência ${period} não foi apurada: não há o que ajustar.`,
        );
      }

      const orchestrator = await deps.orchestratorFor(scope);
      const evento = await orchestrator.processIntention({
        action: 'assessment.adjusted',
        task_id: period,
        actor: context.user.userId,
        period,
        payload: {
          period,
          tax: request.body.tax,
          amount_cents: request.body.amount_cents,
          reason: request.body.reason,
          reference_access_key: request.body.reference_access_key ?? null,
        },
      });

      if (!evento.accepted) {
        throw new ValidationError(
          evento.layer ?? 6,
          'closed_period_violation',
          evento.rejectionReason ?? 'Ajuste rejeitado pelo pipeline.',
        );
      }

      await syncPeriodState(deps.pool, evento.projection!, period);

      const id = await assessment.saveAdjustment(
        scope,
        period,
        {
          tax: request.body.tax,
          amountCents: request.body.amount_cents,
          reason: request.body.reason,
          ...(request.body.reference_access_key === undefined
            ? {}
            : { referenceAccessKey: request.body.reference_access_key }),
        },
        evento.event!.event_seq,
        context.user.userId,
      );

      return reply.code(201).send({
        id,
        event_id: evento.event!.event_id,
        event_seq: evento.event!.event_seq,
        action: evento.event!.action,
        projection_hash: evento.projection!.projection_hash_sha256,
      });
    },
  );

  /**
   * Confirma e fecha a competência. Terminal (INV-001).
   *
   * Exige o `projection_hash` que o usuário viu na tela. Se divergir do atual, a
   * confirmação é recusada com `verification_mismatch`: significa que algo mudou
   * entre a conferência e o clique, e confirmar assim assinaria um número que
   * ninguém revisou.
   */
  app.post<{ Params: ScopeParams; Body: { projection_hash: string; note?: string } }>(
    '/clients/:cnpj/assessments/:period/confirm',
    {
      schema: {
        params: SCOPE_PARAMS,
        body: {
          type: 'object',
          required: ['projection_hash'],
          properties: {
            projection_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            note: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { period } = request.params;

      const orchestrator = await deps.orchestratorFor(scope);
      let confirmado;
      try {
        confirmado = await confirmPeriod({
          pool: deps.pool,
          scope,
          orchestrator,
          period,
          projectionHash: request.body.projection_hash,
          actor: context.user.userId,
          note: request.body.note ?? null,
        });
      } catch (erro) {
        if (erro instanceof PeriodNotAssessedError) throw new NotFoundError(erro.message);
        throw erro;
      }
      const evento = { event: confirmado.event, projection: confirmado.projection };

      return reply.code(200).send({
        event_id: evento.event.event_id,
        event_seq: evento.event.event_seq,
        action: evento.event.action,
        projection_hash: evento.projection.projection_hash_sha256,
        state: 'confirmed',
        // A competência é terminal: a correção é por retificação, não por edição.
        message:
          `Competência ${period} confirmada e fechada. Correções a partir daqui ` +
          'exigem retificação, que abre uma competência vinculada e preserva este hash.',
      });
    },
  );
}
