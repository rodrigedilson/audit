import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import {
  ComparisonNotReadyError,
  ReconciliationService,
} from '../../fiscal/reconciliation/reconciliation.service.js';
import { UploadFormatError } from '../../fiscal/reconciliation/fisco-upload.js';

const PERIOD = '^[0-9]{4}-(0[1-9]|1[0-2])$';

const SCOPE_PARAMS = {
  type: 'object',
  required: ['cnpj', 'period'],
  properties: {
    cnpj: { type: 'string', pattern: '^[0-9]{14}$' },
    period: { type: 'string', pattern: PERIOD },
  },
} as const;

interface ScopeParams {
  cnpj: string;
  period: string;
}

/** 20 MB de CSV cobrem uma proposta nota a nota de um CNPJ grande. */
const MAX_BYTES_UPLOAD = 20 * 1024 * 1024;

const HORIZONTE_PADRAO_DIAS = 30;
const HORIZONTE_MAXIMO_DIAS = 365;

/**
 * Contra-apuração e calendário — diferencial #5.
 *
 * A proposta do Fisco entra por upload manual porque o formato oficial de
 * exposição da apuração assistida ainda está em piloto. Quando ele sair, entra
 * outro parser e estas rotas não mudam — é o que `source` existe para permitir.
 */
export async function registerReconciliationRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const reconciliation = new ReconciliationService(deps.pool);

  app.post<{ Params: ScopeParams }>(
    '/clients/:cnpj/fisco-assessments/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const { content, reference } = await readUpload(request);
      const orchestrator = await deps.orchestratorFor(scope);

      try {
        const resultado = await reconciliation.upload(
          scope,
          request.params.period,
          { source: 'manual_upload', reference, content },
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

  app.get<{ Params: ScopeParams }>(
    '/clients/:cnpj/fisco-assessments/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const comparacao = await reconciliation.find(scope, request.params.period);

      if (!comparacao) {
        throw new NotFoundError(
          `Nenhuma proposta do Fisco registrada para ${request.params.period}. ` +
            'Use POST na mesma rota para enviar a proposta recebida.',
        );
      }

      return comparacao;
    },
  );

  /**
   * A agenda da carteira inteira, e não de um CNPJ por vez.
   *
   * Prazos datados e pendências vêm em listas separadas de propósito: perder um
   * prazo normativo tem consequência jurídica, e uma pendência é trabalho
   * atrasado. A tela não pode dar a mesma cara aos dois.
   */
  app.get<{ Querystring: { horizon_days?: number } }>(
    '/deadlines',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            horizon_days: {
              type: 'integer',
              minimum: 1,
              maximum: HORIZONTE_MAXIMO_DIAS,
              default: HORIZONTE_PADRAO_DIAS,
            },
          },
        },
      },
    },
    async (request) =>
      reconciliation.calendar(
        request.tenant.tenantId,
        request.query.horizon_days ?? HORIZONTE_PADRAO_DIAS,
      ),
  );
}

/**
 * Lê o CSV do multipart, ou o corpo cru como `text/csv`.
 *
 * O `reference` é o nome do arquivo: é o que permite ao contador dizer depois
 * qual proposta ele recebeu e quando, e por isso não é opcional na prática.
 */
async function readUpload(
  request: FastifyRequest,
): Promise<{ content: string; reference: string }> {
  if (typeof request.body === 'string' && request.body.length > 0) {
    return { content: request.body, reference: 'corpo da requisição (text/csv)' };
  }

  if (!request.isMultipart()) {
    throw new ValidationError(
      1,
      'schema_violation',
      'Envie a proposta como multipart/form-data ou com content-type text/csv.',
    );
  }

  // Limite por rota, e não o global do plugin: o teto de 5 MB que cobre um XML
  // de NF-e com folga é pequeno para uma proposta nota a nota de CNPJ grande.
  for await (const part of request.parts({
    limits: { fileSize: MAX_BYTES_UPLOAD, files: 1 },
  })) {
    if (part.type !== 'file') {
      continue;
    }

    const buffer = await part.toBuffer();

    return {
      content: buffer.toString('utf8'),
      reference: part.filename ?? 'proposta.csv',
    };
  }

  throw new ValidationError(1, 'schema_violation', 'Nenhum arquivo enviado.');
}

/**
 * Formato de arquivo é camada 1; pedido fora de ordem é camada 4. Os dois viram
 * rejeição do pipeline, para o painel tratar todas as recusas do mesmo jeito.
 */
function traduzir(cause: unknown): unknown {
  if (cause instanceof UploadFormatError) {
    return new ValidationError(1, 'schema_violation', cause.message);
  }
  if (cause instanceof ComparisonNotReadyError) {
    return new ValidationError(4, 'invalid_transition', cause.message);
  }
  return cause;
}
