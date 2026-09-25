import type { FastifyInstance } from 'fastify';

import type { ApiDeps } from '../server.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { IndexSeriesRepository } from '../../fiscal/rules/index-series.repository.js';
import { accumulateIndex } from '../../fiscal/forensics/calc/indices.js';
import { restate } from '../../fiscal/forensics/calc/monetary.js';
import { CRITERIOS_INTERNOS } from '../../fiscal/shared/criterios-internos.js';

const PERIODO = '^[0-9]{4}-(0[1-9]|1[0-2])$';

/**
 * Séries de índice e correção monetária.
 *
 * As rotas existem para que a tela saiba **o que dá para calcular antes de
 * pedir o cálculo**. Uma série conferida e sem pontos não corrige nada, e o
 * perito precisa ver isso ao montar a peça — não depois, com o resultado
 * devolvendo nulo e ele sem entender por quê.
 *
 * Nenhuma rota é pública: quem consome é o módulo de perícia, atrás de
 * autenticação.
 */
export async function registerIndicesRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const series = new IndexSeriesRepository(deps.pool);

  /** Catálogo com a cobertura de cada série. */
  app.get('/financial-indices', async (_request, reply) => {
    const catalogo = await series.catalog();

    return reply.send({
      indices: catalogo.map((i) => ({
        index_id: i.indexId,
        name: i.name,
        source: i.source,
        verified: i.verified,
        point_count: i.pointCount,
        first_period: i.firstPeriod,
        last_period: i.lastPeriod,
      })),
      /**
       * Declarado no topo, e não deduzível de olho: série sem ponto não corrige
       * nada, e é isso que a tela tem de dizer em vez de oferecer o cálculo.
       */
      loaded_count: catalogo.filter((i) => i.pointCount > 0).length,
      verified_count: catalogo.filter((i) => i.verified).length,
    });
  });

  /**
   * Fator acumulado, e o valor corrigido quando um principal é informado.
   *
   * Responde 200 mesmo quando a série não cobre o intervalo: não é erro do
   * chamador, é dado que falta carregar, e o corpo diz qual. Devolver 4xx faria
   * a tela tratar como falha o que é um estado normal do produto.
   */
  app.get<{
    Params: { index_id: string };
    Querystring: { from: string; to: string; principal_cents?: number };
  }>(
    '/financial-indices/:index_id/factor',
    {
      schema: {
        params: {
          type: 'object',
          required: ['index_id'],
          properties: { index_id: { type: 'string', minLength: 1, maxLength: 32 } },
        },
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', pattern: PERIODO },
            to: { type: 'string', pattern: PERIODO },
            principal_cents: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { index_id: indexId } = request.params;
      const { from, to, principal_cents: principal } = request.query;

      const carregada = await series.load(indexId, from, to);

      // Índice fora do catálogo é erro de quem chamou; série sem ponto não é.
      if (carregada === null) {
        throw new ValidationError(
          2,
          'unknown_code',
          `O índice '${indexId}' não existe no catálogo.`,
          CRITERIOS_INTERNOS['contrato-intencao'],
        );
      }

      const aplicado = accumulateIndex(carregada, from, to);
      const corpo = {
        index_id: aplicado.indexId,
        name: carregada.name,
        from: aplicado.from,
        to: aplicado.to,
        factor: aplicado.factor,
        months: aplicado.months,
        source: aplicado.source,
        verified: aplicado.verified,
        unavailable_reason: aplicado.unavailableReason,
      };

      if (principal === undefined) {
        return reply.send(corpo);
      }

      const corrigido = restate({ principalCents: principal, applied: aplicado });

      return reply.send({
        ...corpo,
        principal_cents: principal,
        restated_cents: corrigido.restatedCents,
        correction_cents: corrigido.correctionCents,
        // A memória vai junto: valor sem ela é valor que o perito não defende.
        steps: corrigido.steps,
      });
    },
  );
}
