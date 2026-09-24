import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { SpedFormatError } from '../../fiscal/ingestion/efd-icms-ipi.parser.js';
import {
  EfdIcmsIpiService,
  EfdIcmsNotImportedError,
  EfdIcmsNotUsableError,
} from '../../fiscal/reconciliation/efd-icms-ipi.service.js';

const PERIOD = '^[0-9]{4}-(0[1-9]|1[0-2])$';

const CNPJ_SCHEMA = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
} as const;

const SCOPE_PARAMS = {
  type: 'object',
  required: ['cnpj', 'period'],
  properties: {
    cnpj: { type: 'string', pattern: '^[0-9]{14}$' },
    period: { type: 'string', pattern: PERIOD },
  },
} as const;

interface CnpjParams {
  cnpj: string;
}

interface ScopeParams extends CnpjParams {
  period: string;
}

/** 60 MB cobrem uma EFD ICMS/IPI de empresa com movimento alto. */
const MAX_BYTES_SPED = 60 * 1024 * 1024;

/**
 * EFD ICMS/IPI: importação e conciliação.
 *
 * A escrituração estadual entra por aqui, e não pelo `POST /clients/:cnpj/sped`,
 * que é da EFD-Contribuições. São dois leiautes com posições de campo próprias,
 * e um endpoint que adivinhasse qual é pelo conteúdo erraria em silêncio no caso
 * que importa: arquivo do tipo errado lido com as posições do outro devolve
 * base no lugar de valor.
 */
export async function registerEfdIcmsIpiRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const servico = new EfdIcmsIpiService(deps.pool);

  app.post<{ Params: CnpjParams }>(
    '/clients/:cnpj/efd-icms-ipi',
    { schema: { params: CNPJ_SCHEMA } },
    async (request, reply) => {
      deps.tenantResolver.assertCanWrite(request.tenant);
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const { content, reference } = await readUpload(request);
      const orchestrator = await deps.orchestratorFor(scope);

      try {
        const resultado = await servico.importFile(
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
   * A conciliação é **derivada na leitura**, e não um resultado guardado.
   *
   * Congelá-la faria uma conferência nova — ou a correção de uma existente —
   * valer só para arquivo importado depois dela, e o cliente continuaria vendo
   * o veredito velho sobre o mesmo arquivo.
   */
  app.get<{ Params: ScopeParams }>(
    '/clients/:cnpj/icms-ipi-reconciliation/:period',
    { schema: { params: SCOPE_PARAMS } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      try {
        return await servico.reconciliation(scope, request.params.period);
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
      'Envie a EFD ICMS/IPI como multipart/form-data ou com content-type text/plain.',
    );
  }

  for await (const part of request.parts({
    limits: { fileSize: MAX_BYTES_SPED, files: 1 },
  })) {
    if (part.type !== 'file') {
      continue;
    }

    // O SPED é gerado em ANSI, não em UTF-8. Ler como UTF-8 corromperia a razão
    // social e, pior, qualquer acento dentro de um campo de texto do arquivo.
    return {
      content: (await part.toBuffer()).toString('latin1'),
      reference: part.filename ?? 'efd-icms-ipi.txt',
    };
  }

  throw new ValidationError(1, 'schema_violation', 'Nenhum arquivo enviado.');
}

/**
 * Formato é camada 1; CNPJ divergente é camada 0 de isolamento, que no contrato
 * aparece como `tenant_violation`; conciliação sem escrituração é 404, porque
 * falta um recurso e não há nada de errado com o pedido.
 */
function traduzir(cause: unknown): unknown {
  if (cause instanceof SpedFormatError) {
    return new ValidationError(1, 'schema_violation', cause.message);
  }
  if (cause instanceof EfdIcmsNotUsableError) {
    return new ValidationError(2, 'tenant_violation', cause.message);
  }
  if (cause instanceof EfdIcmsNotImportedError) {
    return new NotFoundError(cause.message);
  }
  return cause;
}
