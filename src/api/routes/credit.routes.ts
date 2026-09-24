import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import {
  CreditService,
  StatementNotUsableError,
} from '../../fiscal/credit/credit.service.js';
import { StatementFormatError } from '../../fiscal/credit/statement-parser.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';

const PERIOD = '^[0-9]{4}-(0[1-9]|1[0-2])$';

const CNPJ_SCHEMA = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
} as const;

interface CnpjParams {
  cnpj: string;
}

/** 20 MB cobrem um extrato anual de conta movimentada. */
const MAX_BYTES_EXTRATO = 20 * 1024 * 1024;

/**
 * Crédito em risco por fornecedor — diferencial #7.
 *
 * Substitui o `501` que a Onda 4 devolvia em `POST /bank-statements`: ali o
 * caminho previsto era open finance, que depende de fonte externa; aqui é o
 * upload manual de OFX ou CSV, que é o caminho de menor risco e já entrega o
 * dado de que o crédito precisa.
 */
export async function registerCreditRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const credit = new CreditService(deps.pool);

  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/bank-statements',
    { schema: { params: CNPJ_SCHEMA } },
    async (request, reply) => {
      deps.tenantResolver.assertCanWrite(request.tenant);
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const { content, reference } = await readUpload(request);
      const orchestrator = await deps.orchestratorFor(scope);

      try {
        const resultado = await credit.importStatement(
          scope,
          { content, reference },
          orchestrator,
          request.tenant.user.userId,
          request.tenant.user.userId,
        );
        return reply.code(201).send(resultado);
      } catch (cause) {
        throw traduzir(cause);
      }
    },
  );

  /**
   * Refaz o casamento sem importar nada.
   *
   * Serve depois de ingerir documentos novos: um lançamento que não tinha
   * candidato passa a ter, e uma ambiguidade pode se resolver. Não grava evento
   * fiscal — casamento é conclusão sobre dados já no log, não fato novo.
   */
  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/payment-matches',
    { schema: { params: CNPJ_SCHEMA } },
    async (request) => {
      deps.tenantResolver.assertCanWrite(request.tenant);
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const matches = await credit.rematch(scope);

      return {
        matches,
        total: matches.length,
        ambiguous: matches.filter((m) => m.confidence === 'ambiguous').length,
      };
    },
  );

  app.get<{ Params: CnpjParams; Querystring: { period?: string } }>(
    '/clients/:cnpj/credits/at-risk',
    {
      schema: {
        params: CNPJ_SCHEMA,
        querystring: {
          type: 'object',
          properties: { period: { type: 'string', pattern: PERIOD } },
        },
      },
    },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      return credit.riskReport(scope, request.query.period);
    },
  );
}

async function readUpload(
  request: FastifyRequest,
): Promise<{ content: string; reference: string }> {
  if (typeof request.body === 'string' && request.body.length > 0) {
    return { content: request.body, reference: 'corpo da requisição' };
  }

  if (!request.isMultipart()) {
    throw new ValidationError(
      1,
      'schema_violation',
      'Envie o extrato como multipart/form-data ou com content-type text/csv.',
    );
  }

  for await (const part of request.parts({
    limits: { fileSize: MAX_BYTES_EXTRATO, files: 1 },
  })) {
    if (part.type !== 'file') {
      continue;
    }

    return {
      content: (await part.toBuffer()).toString('utf8'),
      reference: part.filename ?? 'extrato',
    };
  }

  throw new ValidationError(1, 'schema_violation', 'Nenhum arquivo enviado.');
}

/** Formato é camada 1; extrato sem lançamento aproveitável também é forma. */
function traduzir(cause: unknown): unknown {
  if (cause instanceof StatementFormatError || cause instanceof StatementNotUsableError) {
    return new ValidationError(1, 'schema_violation', cause.message);
  }
  return cause;
}
