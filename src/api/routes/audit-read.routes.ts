import type { FastifyInstance } from 'fastify';

import type { ApiDeps } from '../server.js';
import { AuditReadModel } from '../../fiscal/audit/audit-read-model.js';
import type { FindingStatus } from '../../fiscal/audit/findings.js';
import { TRILHAS_INICIAIS } from '../../fiscal/audit/trilhas-iniciais.js';
import { CNPJ_PERIOD_SCHEMA, type CnpjPeriodParams } from './audit.routes.js';

/**
 * Leitura da auditoria contínua: o que a tela precisa para dizer o que foi
 * examinado, o que ficou sem conclusão e por quê.
 *
 * Separada das escritas em `audit.routes.ts` porque nenhuma destas rotas emite
 * evento. Qualquer membro lê; viewer inclusive.
 */
export async function registerAuditReadRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const leitura = new AuditReadModel(deps.pool);

  /**
   * Catálogo das trilhas, com o estado do critério de cada uma.
   *
   * O critério vem junto porque é ele que decide se a execução vai afirmar
   * alguma coisa. Sem isso a tela só descobriria o "não conferido" depois de
   * executar — e o contador leria a inconclusão como defeito do sistema.
   */
  app.get('/audit-procedures', async (_request, reply) => {
    const criterios = await leitura.criteria([...new Set(TRILHAS_INICIAIS.map((p) => p.criterionId))]);

    return reply.send({
      procedures: TRILHAS_INICIAIS.map((p) => ({
        procedure_id: p.procedureId,
        name: p.name,
        description: p.description,
        population: p.population,
        sampling_technique: p.sampling.technique,
        verifications: p.verifications,
        criterion_id: p.criterionId,
        /** `null` quando a trilha cita um critério que não está carregado. */
        criterion: criterios.get(p.criterionId) ?? null,
        reversal_policy: p.reversalPolicy,
        active: p.active,
      })),
      /**
       * Declarado, e não escondido: das trilhas listadas, as inativas dependem
       * de dado que a ingestão ainda não coleta. O escritório precisa ver o que
       * ainda não é conferido, em vez de supor que é.
       */
      inactive_count: TRILHAS_INICIAIS.filter((p) => !p.active).length,
    });
  });

  /**
   * A última execução de cada trilha na competência.
   *
   * Lista vazia quer dizer "nunca executada", e não "executada sem achado" — a
   * tela tem de dar cara diferente aos dois.
   */
  app.get<{ Params: CnpjPeriodParams }>(
    '/clients/:cnpj/audit/:period/executions',
    { schema: { params: CNPJ_PERIOD_SCHEMA } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const executions = await leitura.executions(scope, request.params.period);

      return reply.send({ period: request.params.period, executions });
    },
  );

  app.get<{
    Params: CnpjPeriodParams;
    Querystring: { status?: FindingStatus; procedure_id?: string };
  }>(
    '/clients/:cnpj/audit/:period/findings',
    {
      schema: {
        params: CNPJ_PERIOD_SCHEMA,
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'accepted', 'rejected', 'resolved'] },
            procedure_id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const filtro: { status?: FindingStatus; procedureId?: string } = {};
      if (request.query.status !== undefined) {
        filtro.status = request.query.status;
      }
      if (request.query.procedure_id !== undefined) {
        filtro.procedureId = request.query.procedure_id;
      }

      const findings = await leitura.findings(scope, request.params.period, filtro);

      return reply.send({ period: request.params.period, findings });
    },
  );

  /** O painel do escritório. Só o tenant da sessão, nunca a carteira de outro. */
  app.get('/audit/overview', async (request, reply) =>
    reply.send(await leitura.overview(request.tenant.tenantId)),
  );
}
