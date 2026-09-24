import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import {
  BookNotReadyError,
  ReportingService,
  type BookOptions,
} from '../../fiscal/reporting/reporting.service.js';
import type { Audience } from '../../fiscal/reporting/book-pdf.js';
import type { Regime } from '../../fiscal/shared/fiscal-vocabulary.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';

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

interface BookBody {
  audience?: Audience;
  white_label?: boolean;
  include_trace?: boolean;
}

/**
 * Trilhas de auditoria e Book de fechamento — diferencial #3.
 *
 * É o primeiro entregável que sai do escritório para o cliente final. Por isso
 * o download devolve os bytes guardados, e não uma regeração: o hash impresso
 * no rodapé tem de continuar valendo depois que uma regra mudar.
 */
export async function registerReportingRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const reporting = new ReportingService(deps.pool);

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

  /**
   * Catálogo das trilhas, sem competência.
   *
   * A lista é o que este sistema confere de fato — não uma lista de
   * verificações da RFB. Expor o catálogo antes de qualquer apuração é o que
   * permite ao escritório saber o que está comprando.
   */
  app.get<{ Querystring: { regime?: Regime } }>(
    '/audit-trails',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            regime: {
              type: 'string',
              enum: ['mei', 'simples_integrado', 'simples_hibrido', 'lucro_presumido', 'lucro_real'],
            },
          },
        },
      },
    },
    async (request) => {
      const trilhas = await reporting.definitions(request.query.regime);
      return { trails: trilhas, total: trilhas.length };
    },
  );

  app.get<{ Params: ScopeParams }>(
    '/clients/:cnpj/audit-trails/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const regime = await regimeDoCliente(scope.tenantId, scope.cnpj);

      try {
        return await reporting.report(scope, request.params.period, regime);
      } catch (cause) {
        throw traduzir(cause);
      }
    },
  );

  app.post<{ Params: ScopeParams; Body: BookBody }>(
    '/clients/:cnpj/books/:period',
    {
      schema: {
        params: SCOPE_PARAMS,
        body: {
          type: 'object',
          properties: {
            audience: { type: 'string', enum: ['accountant', 'business_owner'] },
            white_label: { type: 'boolean' },
            include_trace: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const regime = await regimeDoCliente(scope.tenantId, scope.cnpj);
      const body = request.body ?? {};

      if (body.white_label === true) {
        await deps.planFeatures.exigir(regime, 'white_label');
      }

      const options: BookOptions = {
        audience: body.audience ?? 'accountant',
        whiteLabel: body.white_label ?? false,
        // A memória de cálculo é o anexo que sustenta o número; sai por omissão,
        // e só é retirada quando o Book vai para o dono da empresa.
        includeTrace: body.include_trace ?? body.audience !== 'business_owner',
      };

      const orchestrator = await deps.orchestratorFor(scope);

      try {
        const book = await reporting.generate(
          scope,
          request.params.period,
          regime,
          options,
          orchestrator,
          request.tenant.user.userId,
          request.tenant.user.userId,
        );
        return reply.code(201).send(book);
      } catch (cause) {
        throw traduzir(cause);
      }
    },
  );

  app.get<{ Params: ScopeParams }>(
    '/clients/:cnpj/books/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const books = await reporting.list(scope, request.params.period);
      return { books, total: books.length };
    },
  );

  /**
   * Download dos bytes guardados.
   *
   * O `X-Book-SHA256` no cabeçalho permite ao destinatário conferir o arquivo
   * que recebeu contra o que a API tem, sem abrir o PDF.
   */
  app.get<{ Params: { cnpj: string; period: string; book_id: string } }>(
    '/clients/:cnpj/books/:period/:book_id/download',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cnpj', 'period', 'book_id'],
          properties: {
            cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
            period: { type: 'string', pattern: PERIOD },
            book_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const book = await reporting.download(scope, request.params.book_id);

      if (!book || book.period !== request.params.period) {
        throw new NotFoundError(`Book ${request.params.book_id} não encontrado nesta carteira.`);
      }

      return reply
        .header('content-type', 'application/pdf')
        .header('x-book-sha256', book.sha256)
        .header(
          'content-disposition',
          `attachment; filename="book-${scope.cnpj}-${book.period}.pdf"`,
        )
        .send(book.pdf);
    },
  );
}

/**
 * `BookNotReadyError` é pedido fora de ordem, não defeito: virou 422 com camada,
 * como as demais rejeições do pipeline, para o painel tratar todas igual.
 */
function traduzir(cause: unknown): unknown {
  if (cause instanceof BookNotReadyError) {
    return new ValidationError(4, 'invalid_transition', cause.message);
  }
  return cause;
}
