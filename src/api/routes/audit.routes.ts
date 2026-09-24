import type { FastifyInstance } from 'fastify';

import type { ApiDeps } from '../server.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { AuditService } from '../../fiscal/audit/audit.service.js';
import { canApply, propose, type FindingStatus } from '../../fiscal/audit/findings.js';
import type { AuditFinding } from '../../fiscal/audit/findings.js';
import { CRITERIOS_INTERNOS } from '../../fiscal/shared/criterios-internos.js';
import type { PeriodState } from '../../fiscal/shared/fiscal-vocabulary.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';

/**
 * `ProcessResult.event` é opcional no tipo porque a rejeição também devolve um
 * evento. Aceito sem evento seria defeito do orquestrador, não caso de uso — e
 * gravar a execução com `event_seq` inventado quebraria o elo entre a tabela de
 * leitura e o log, que é justamente o que torna o achado conferível.
 */
function seqDoEvento(evento: { accepted: boolean; event?: { event_seq: number } }): number {
  if (evento.event === undefined) {
    throw new Error('Intenção aceita sem evento: o log e a leitura ficariam sem elo.');
  }
  return evento.event.event_seq;
}

const CNPJ_PERIOD_SCHEMA = {
  type: 'object',
  required: ['cnpj', 'period'],
  properties: {
    cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
    period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
  },
} as const;

interface CnpjPeriodParams {
  cnpj: string;
  period: string;
}

/**
 * Auditoria contínua — teste de comprovação e inspeção documentária.
 *
 * O fluxo tem três atos, e a separação entre eles é o produto: o sistema
 * **examina**, o contador **revisa**, e só então alguém **estorna**. Nenhum dos
 * três atalha o anterior, e é isso que faz o achado sobreviver a uma
 * contestação.
 */
export async function registerAuditRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const audit = new AuditService(deps.pool);

  /** Catálogo das trilhas. Não depende de cliente nem de competência. */
  app.get('/audit-procedures', async (_request, reply) => {
    const procedures = audit.procedures();

    return reply.send({
      procedures: procedures.map((p) => ({
        procedure_id: p.procedureId,
        name: p.name,
        description: p.description,
        population: p.population,
        sampling_technique: p.sampling.technique,
        verifications: p.verifications,
        criterion_id: p.criterionId,
        reversal_policy: p.reversalPolicy,
        active: p.active,
      })),
      /**
       * Declarado, e não escondido: das trilhas listadas, as inativas dependem
       * de dado que a ingestão ainda não coleta. O escritório precisa ver o que
       * ainda não é conferido, em vez de supor que é.
       */
      inactive_count: procedures.filter((p) => !p.active).length,
    });
  });

  /**
   * Executa as trilhas ativas sobre a competência.
   *
   * Responde **207** sempre que executa mais de uma, inclusive quando todas
   * concluíram: variar o status conforme o resultado obrigaria o cliente a
   * manter dois parsers. É o precedente da ingestão em lote.
   */
  app.post<{ Params: CnpjPeriodParams; Body: { procedure_ids?: string[] } }>(
    '/clients/:cnpj/audit/:period/executions',
    {
      schema: {
        params: CNPJ_PERIOD_SCHEMA,
        /**
         * Aceita corpo ausente: executar todas as trilhas ativas é o caso
         * comum, e exigir `{}` faria a chamada mais frequente ser a mais chata.
         */
        body: {
          type: ['object', 'null'],
          properties: {
            procedure_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { period } = request.params;
      const pedidas = request.body?.procedure_ids;

      const trilhas = audit
        .procedures()
        .filter((p) => (pedidas === undefined ? p.active : pedidas.includes(p.procedureId)));

      if (trilhas.length === 0) {
        throw new ValidationError(
          2,
          'schema_violation',
          'Nenhuma trilha ativa corresponde ao pedido.',
          CRITERIOS_INTERNOS['contrato-intencao'],
        );
      }

      const orchestrator = await deps.orchestratorFor(scope);
      const hoje = new Date().toISOString().slice(0, 10);
      const resultados = [];

      for (const trilha of trilhas) {
        const saida = await audit.run(scope, trilha, period, hoje);

        const evento = await orchestrator.processIntention({
          action: 'audit.execution.recorded',
          task_id: `${trilha.procedureId}:${period}`,
          actor: context.user.userId,
          period,
          payload: {
            procedure_id: trilha.procedureId,
            status: saida.status,
            inconclusive_reason: saida.inconclusiveReason,
            population_size: saida.populationSize,
            examined_count: saida.examinedCount,
            findings_count: saida.findings.length,
            total_impact_cents: saida.totalImpactCents,
            criterion_id: trilha.criterionId,
            criterion_verified: saida.criterionVerified,
          },
        });

        if (!evento.accepted) {
          throw new ValidationError(
            evento.layer ?? 4,
            'invalid_transition',
            evento.rejectionReason ?? 'Execução rejeitada pelo pipeline.',
          );
        }

        await audit.persist(
          scope,
          saida,
          trilha.criterionId,
          seqDoEvento(evento),
          context.user.userId,
        );

        resultados.push({
          procedure_id: trilha.procedureId,
          status: saida.status,
          inconclusive_reason: saida.inconclusiveReason,
          population_size: saida.populationSize,
          examined_count: saida.examinedCount,
          findings_count: saida.findings.length,
          total_impact_cents: saida.totalImpactCents,
          criterion_verified: saida.criterionVerified,
        });
      }

      return reply.code(207).send({ period, executions: resultados });
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

      const achados = await audit.findings(scope, request.params.period, filtro);

      return reply.send({ period: request.params.period, findings: achados });
    },
  );

  /** O contador aceita, recusa ou dá por resolvido. Recusar exige motivo. */
  app.post<{
    Params: { cnpj: string; finding_id: string };
    Body: { status: 'accepted' | 'rejected' | 'resolved'; note?: string };
  }>(
    '/clients/:cnpj/audit/findings/:finding_id/review',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj', 'finding_id'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            finding_id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['accepted', 'rejected', 'resolved'] },
            note: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { finding_id: findingId } = request.params;
      const { status, note } = request.body;

      const achado = await audit.finding(scope, findingId);
      if (achado === null) {
        throw new ValidationError(
          2,
          'schema_violation',
          `Achado '${findingId}' não existe nesta carteira.`,
          CRITERIOS_INTERNOS['isolamento-por-escritorio'],
        );
      }

      // Discordar sem motivo escrito não é revisão — é o que o Book teria de
      // imprimir ao lado do achado recusado.
      if (status === 'rejected' && (note === undefined || note.trim().length === 0)) {
        throw new ValidationError(
          2,
          'schema_violation',
          'Recusar um achado exige justificativa: ela vai impressa no Book.',
          CRITERIOS_INTERNOS['contrato-intencao'],
        );
      }

      const orchestrator = await deps.orchestratorFor(scope);
      const evento = await orchestrator.processIntention({
        action: 'audit.finding.reviewed',
        task_id: findingId,
        actor: context.user.userId,
        period: String(achado['period']),
        payload: { finding_id: findingId, status, note: note ?? null },
      });

      if (!evento.accepted) {
        throw new ValidationError(
          evento.layer ?? 4,
          'invalid_transition',
          evento.rejectionReason ?? 'Revisão rejeitada pelo pipeline.',
        );
      }

      await audit.review(scope, findingId, status, context.user.userId, note ?? null);

      return reply.send({ finding_id: findingId, status });
    },
  );

  /**
   * Aplica o estorno.
   *
   * Devolve **422 com a lista de impedimentos** em vez de uma mensagem única:
   * a tela precisa dizer tudo que falta de uma vez, e não descobrir um
   * bloqueio por tentativa.
   */
  app.post<{ Params: { cnpj: string; finding_id: string } }>(
    '/clients/:cnpj/audit/findings/:finding_id/reversal',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj', 'finding_id'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            finding_id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const { finding_id: findingId } = request.params;

      const linha = await audit.finding(scope, findingId);
      if (linha === null) {
        throw new ValidationError(
          2,
          'schema_violation',
          `Achado '${findingId}' não existe nesta carteira.`,
          CRITERIOS_INTERNOS['isolamento-por-escritorio'],
        );
      }

      const period = String(linha['period']);
      const orchestrator = await deps.orchestratorFor(scope);
      const projecao = await orchestrator.getProjection();
      const estado: PeriodState = projecao.periods[period]?.state ?? 'open';

      const criterio = await audit.criterion(String(linha['criterion_id']));
      const achado = {
        findingId,
        procedureId: String(linha['procedure_id'] ?? ''),
        period,
        subject: String(linha['subject']),
        verifications: [],
        failed: (linha['failed'] ?? []) as AuditFinding['failed'],
        impactCents: Number(linha['impact_cents']),
        impactSide: linha['impact_side'] as AuditFinding['impactSide'],
        risk: {} as AuditFinding['risk'],
        criterion:
          criterio === null
            ? null
            : {
                criterion_id: criterio.criterionId,
                kind: criterio.kind,
                citation: criterio.citation,
                verified: criterio.verified,
              },
        assertable: linha['assertable'] === true,
        status: linha['status'] as FindingStatus,
      } satisfies AuditFinding;

      const proposta = propose({
        finding: achado,
        periodState: estado,
        alreadyReversed: await audit.alreadyReversed(scope, findingId),
      });

      if (!canApply(proposta)) {
        return reply.code(422).send({
          finding_id: findingId,
          blockers: proposta.blockers,
          net_effect_cents: proposta.netEffectCents,
          message:
            'O estorno não pode ser aplicado ainda. Cada impedimento tem de ser ' +
            'resolvido antes: o sistema propõe, quem invalida um lançamento é você.',
        });
      }

      const evento = await orchestrator.processIntention({
        action: 'audit.reversal.applied',
        task_id: findingId,
        actor: context.user.userId,
        period,
        payload: {
          finding_id: findingId,
          period,
          credit_reversed_cents: proposta.creditReversedCents,
          debit_constituted_cents: proposta.debitConstitutedCents,
          net_effect_cents: proposta.netEffectCents,
          verification: proposta.basis.verification,
          criterion_id: proposta.basis.criterion?.criterion_id ?? null,
          citation: proposta.basis.criterion?.citation ?? null,
        },
      });

      if (!evento.accepted) {
        throw new ValidationError(
          evento.layer ?? 6,
          'closed_period_violation',
          evento.rejectionReason ?? 'Estorno rejeitado pelo pipeline.',
        );
      }

      await audit.saveReversal(scope, {
        findingId,
        period,
        creditReversedCents: proposta.creditReversedCents,
        debitConstitutedCents: proposta.debitConstitutedCents,
        netEffectCents: proposta.netEffectCents,
        verification: proposta.basis.verification ?? '',
        criterionId: String(linha['criterion_id']),
        citation: proposta.basis.criterion?.citation ?? '',
        eventSeq: seqDoEvento(evento),
        appliedBy: context.user.userId,
      });

      return reply.code(201).send({
        finding_id: findingId,
        period,
        credit_reversed_cents: proposta.creditReversedCents,
        debit_constituted_cents: proposta.debitConstitutedCents,
        net_effect_cents: proposta.netEffectCents,
        citation: proposta.basis.criterion?.citation ?? null,
      });
    },
  );
}
