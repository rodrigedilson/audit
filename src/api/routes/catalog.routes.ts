import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { CatalogService } from '../../fiscal/catalog/catalog.service.js';
import type { Classification, Health } from '../../fiscal/catalog/code-validation.js';

const CNPJ_SCHEMA = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface ClassificationBody {
  effective_from: string;
  ncm?: string;
  nbs?: string;
  cst_ibs_cbs?: string;
  cclasstrib?: string;
  cst_icms?: string;
  cst_pis_cofins?: string;
  cfop_default?: string;
  justification?: string;
}

/**
 * Catálogo de itens e saúde do cadastro — diferencial #1.
 *
 * Ataca a raiz: o erro nasce no cadastro do item e contamina toda nota emitida
 * com ele. A rota de saúde responde quantas notas **já emitidas** cada item mal
 * classificado contaminou, que é a pergunta que um verificador de XML não
 * alcança.
 */
export async function registerCatalogRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const catalog = new CatalogService(deps.pool);

  app.get<{
    Params: CnpjParams;
    Querystring: { health?: Health | 'never'; page?: number; page_size?: number };
  }>(
    '/clients/:cnpj/items',
    {
      schema: {
        params: CNPJ_SCHEMA,
        querystring: {
          type: 'object',
          properties: {
            // `never` isola o item nunca classificado, que é trabalho não
            // começado — distinto de `warning`, que é trabalho feito com
            // pendência. Os dois somados eram um número só, e a tela não
            // conseguia dizer qual estava mostrando.
            health: { type: 'string', enum: ['ok', 'warning', 'error', 'never'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      const filtro: { health?: Health | 'never'; page: number; pageSize: number } = {
        page: request.query.page ?? 1,
        pageSize: request.query.page_size ?? 50,
      };
      if (request.query.health !== undefined) {
        filtro.health = request.query.health;
      }

      const { items, total } = await catalog.listItems(scope, filtro);

      return reply.code(200).send({ items, page: filtro.page, total });
    },
  );

  /**
   * Confirma a classificação do item. Emite `item.classified` na primeira vez e
   * `item.reclassified` depois — a distinção importa porque reclassificar é um
   * ato que o contador pode precisar justificar.
   *
   * A saúde é apurada **antes** do evento e vai no payload: recalcular na
   * projeção usaria as tabelas de hoje para julgar uma classificação de ontem.
   */
  app.put<{ Params: CnpjParams & { item_id: string }; Body: ClassificationBody }>(
    '/clients/:cnpj/items/:item_id/classification',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj', 'item_id'],
          properties: {
            cnpj: { type: 'string', pattern: '^[0-9]{14}$' },
            item_id: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        body: {
          type: 'object',
          required: ['effective_from'],
          properties: {
            effective_from: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
            ncm: { type: 'string' },
            nbs: { type: 'string' },
            cst_ibs_cbs: { type: 'string' },
            cclasstrib: { type: 'string' },
            cst_icms: { type: 'string' },
            cst_pis_cofins: { type: 'string' },
            cfop_default: { type: 'string' },
            justification: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);

      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);
      const itemId = request.params.item_id;
      const classification = toClassification(request.body);

      const outcome = await catalog.validate(classification);

      // Inconsistência de mérito não bloqueia o registro: o contador pode
      // precisar classificar exatamente como está no documento do fornecedor, e
      // a inconsistência é justamente o que o produto tem de mostrar. Bloquear
      // faria o escritório resolver isso fora do sistema, sem trilha.
      const jaClassificado = await catalog.hasClassification(scope, itemId);
      const action = jaClassificado ? 'item.reclassified' : 'item.classified';

      const orchestrator = await deps.orchestratorFor(scope);

      /**
       * INV-001 aplicado ao catálogo: uma vigência que cai numa competência já
       * confirmada mudaria retroativamente a apuração daquele mês, porque a
       * classificação vigente é a de maior `effective_from` até o período. A
       * saída prevista é a retificação, não a reclassificação.
       */
      const projecao = await orchestrator.getProjection();
      if (projecao.periods[classification.effectiveFrom]?.state === 'confirmed') {
        throw new ValidationError(
          6,
          'closed_period_violation',
          `A competência ${classification.effectiveFrom} está confirmada. Classificar com ` +
            'essa vigência alteraria uma apuração já fechada — use uma vigência posterior ' +
            'ou registre uma retificação.',
        );
      }

      const result = await orchestrator.processIntention({
        action,
        task_id: itemId,
        actor: context.user.userId,
        // Sem `period`: o evento é do catálogo do CNPJ, não de uma competência.
        // Passá-lo faria a camada 4 exigir a competência aberta, e o catálogo é
        // preparado ANTES do mês começar. A vigência vai no payload.
        payload: {
          item_id: itemId,
          effective_from: classification.effectiveFrom,
          ncm: classification.ncm ?? null,
          nbs: classification.nbs ?? null,
          cst_ibs_cbs: classification.cstIbsCbs ?? null,
          cclasstrib: classification.cclasstrib ?? null,
          cst_icms: classification.cstIcms ?? null,
          cst_pis_cofins: classification.cstPisCofins ?? null,
          cfop_default: classification.cfopDefault ?? null,
          justification: classification.justification ?? null,
          health: outcome.health,
          reasons: outcome.issues.map((i) => i.message),
        },
      });

      if (!result.accepted) {
        throw new ValidationError(
          result.layer ?? 3,
          'schema_violation',
          result.rejectionReason ?? 'Classificação rejeitada pelo pipeline.',
        );
      }

      await catalog.saveClassification(
        scope,
        itemId,
        classification,
        outcome,
        result.event!.event_seq,
        context.user.userId,
      );

      return reply.code(200).send({
        event_id: result.event!.event_id,
        event_seq: result.event!.event_seq,
        action: result.event!.action,
        projection_hash: result.projection!.projection_hash_sha256,
        health: outcome.health,
        issues: outcome.issues,
        ...(outcome.flags === undefined ? {} : { ncm_flags: outcome.flags }),
      });
    },
  );

  /**
   * Saúde do cadastro com propagação para as notas emitidas.
   *
   * `outbound_documents_affected` é o número que vende o produto: notas já
   * emitidas com item mal classificado.
   */
  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/items/health',
    { schema: { params: CNPJ_SCHEMA } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const health = await catalog.health(scope);

      return reply.code(200).send({
        ...health,
        // Dito na resposta, não deixado implícito num contador: sem as tabelas
        // oficiais carregadas, "nenhum erro" não significa "está correto".
        ...(health.reference_tables_loaded
          ? {}
          : {
              notice:
                'Tabelas oficiais de códigos não carregadas: a ausência de erro aqui ' +
                'não significa que a classificação está correta. Carregue fiscal_codes ' +
                'e cclasstrib_cst.',
            }),
      });
    },
  );
}

function toClassification(body: ClassificationBody): Classification {
  const opcional = <K extends string>(chave: K, valor: string | undefined) =>
    valor === undefined || valor.trim().length === 0 ? {} : { [chave]: valor.trim() };

  return {
    effectiveFrom: body.effective_from,
    ...opcional('ncm', body.ncm),
    ...opcional('nbs', body.nbs),
    ...opcional('cstIbsCbs', body.cst_ibs_cbs),
    ...opcional('cclasstrib', body.cclasstrib),
    ...opcional('cstIcms', body.cst_icms),
    ...opcional('cstPisCofins', body.cst_pis_cofins),
    ...opcional('cfopDefault', body.cfop_default),
    ...opcional('justification', body.justification),
  } as Classification;
}
