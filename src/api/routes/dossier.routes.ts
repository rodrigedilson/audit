import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import {
  DossierNotReadyError,
  DossierService,
  SpedNotUsableError,
} from '../../fiscal/dossier/dossier.service.js';
import { SpedFormatError } from '../../fiscal/dossier/sped-parser.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';

const PERIOD = '^[0-9]{4}-(0[1-9]|1[0-2])$';

const CNPJ_SCHEMA = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
} as const;

const SCOPE_PARAMS = {
  type: 'object',
  required: ['cnpj', 'period'],
  properties: {
    cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ },
    period: { type: 'string', pattern: PERIOD },
  },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface ScopeParams extends CnpjParams {
  period: string;
}

/** 60 MB cobrem uma EFD-Contribuições de empresa com movimento alto. */
const MAX_BYTES_SPED = 60 * 1024 * 1024;

/**
 * Dossiê de saldo credor PIS/Cofins — diferencial #9.
 *
 * Substitui o `501` que a Onda 4 devolvia em `POST /sped`: ali o caminho previsto
 * era a coleta automática, que depende de fonte externa; aqui é o upload do
 * arquivo que o cliente já gera hoje, e que é a fonte de verdade do saldo credor.
 */
export async function registerDossierRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const dossier = new DossierService(deps.pool);

  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/sped',
    { schema: { params: CNPJ_SCHEMA } },
    async (request, reply) => {
      deps.tenantResolver.assertCanWrite(request.tenant);
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const { content, reference } = await readUpload(request);
      const orchestrator = await deps.orchestratorFor(scope);

      try {
        const resultado = await dossier.importSped(
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
   * O dossiê é **derivado na leitura**, e não um resultado guardado.
   *
   * É deliberado: congelá-lo esconderia o ganho de lastro que acontece quando o
   * escritório localiza um XML que faltava — e localizar documento é exatamente
   * o trabalho que o dossiê encomenda.
   */
  app.get<{ Params: ScopeParams }>(
    '/clients/:cnpj/credit-dossier/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      try {
        return await dossier.dossier(scope, request.params.period);
      } catch (cause) {
        throw traduzir(cause);
      }
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
      'Envie a EFD-Contribuições como multipart/form-data ou com content-type text/plain.',
    );
  }

  for await (const part of request.parts({
    limits: { fileSize: MAX_BYTES_SPED, files: 1 },
  })) {
    if (part.type !== 'file') {
      continue;
    }

    return {
      content: (await part.toBuffer()).toString('latin1'),
      reference: part.filename ?? 'efd-contribuicoes.txt',
    };
  }

  throw new ValidationError(1, 'schema_violation', 'Nenhum arquivo enviado.');
}

/**
 * Formato é camada 1; CNPJ divergente é camada 0 de isolamento, que no contrato
 * aparece como `tenant_violation`; dossiê sem escrituração é 404, porque falta
 * um recurso e não há nada de errado com o pedido.
 */
function traduzir(cause: unknown): unknown {
  if (cause instanceof SpedFormatError) {
    return new ValidationError(1, 'schema_violation', cause.message);
  }
  if (cause instanceof SpedNotUsableError) {
    return new ValidationError(2, 'tenant_violation', cause.message);
  }
  if (cause instanceof DossierNotReadyError) {
    return new NotFoundError(cause.message);
  }
  return cause;
}
