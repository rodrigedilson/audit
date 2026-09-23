import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { NotFoundError } from '../auth/tenant-resolver.js';
import { ForbiddenError } from '../auth/tenant-resolver.js';
import {
  AssistantNotInPlanError,
  AssistantQuotaError,
  AssistantService,
  ThreadNotFoundError,
} from '../../fiscal/assistant/assistant.service.js';
import { PERGUNTAS_SUPORTADAS } from '../../fiscal/assistant/intent-classifier.js';

const CNPJ_SCHEMA = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: '^[0-9]{14}$' } },
} as const;

const THREAD_SCHEMA = {
  type: 'object',
  required: ['cnpj', 'thread_id'],
  properties: {
    cnpj: { type: 'string', pattern: '^[0-9]{14}$' },
    thread_id: { type: 'string', format: 'uuid' },
  },
} as const;

/** Pergunta longa é quase sempre colagem de documento; o assistente não é isso. */
const MAX_CARACTERES_PERGUNTA = 1_000;

interface CnpjParams {
  cnpj: string;
}

interface ThreadParams extends CnpjParams {
  thread_id: string;
}

/**
 * Assistente fiscal somente leitura — diferencial #6.
 *
 * Nenhuma rota daqui chama o orquestrador: o serviço nem recebe um. Ação
 * recomendada sai em `suggested_intentions`, com rota e corpo prontos, e quem
 * executa é o usuário. É o que separa "assistente que sugere" de "agente que
 * mexe no número fiscal sozinho".
 */
export async function registerAssistantRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const assistant = new AssistantService(deps.pool);

  /** O catálogo de perguntas, sem CNPJ: serve de ajuda e de material de venda. */
  app.get('/assistant/capabilities', async () => {
    /**
     * Declarado no contrato porque muda o que o usuário pode esperar: camada 1
     * é consulta determinística e reproduzível; a 3 depende de modelo de
     * linguagem. Derivado do serviço, e não escrito aqui, para a resposta não
     * continuar dizendo "sem modelo" no dia em que um for ligado.
     */
    const configured = assistant.languageModelName !== undefined;
    return {
      supported: Object.entries(PERGUNTAS_SUPORTADAS).map(([intent, description]) => ({
        intent,
        description,
      })),
      deterministic_only: !configured,
      language_model_configured: configured,
    };
  });

  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/assistant/usage',
    { schema: { params: CNPJ_SCHEMA } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      return assistant.usage(scope);
    },
  );

  app.get<{ Params: CnpjParams }>(
    '/clients/:cnpj/assistant/threads',
    { schema: { params: CNPJ_SCHEMA } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const threads = await assistant.listThreads(scope);
      return { threads, total: threads.length };
    },
  );

  app.post<{ Params: CnpjParams; Body: { title?: string } }>(
    '/clients/:cnpj/assistant/threads',
    {
      schema: {
        params: CNPJ_SCHEMA,
        body: {
          type: 'object',
          properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      try {
        const thread = await assistant.createThread(
          scope,
          request.body?.title ?? 'Nova conversa',
          request.tenant.user.userId,
        );
        return reply.code(201).send(thread);
      } catch (cause) {
        throw traduzir(cause);
      }
    },
  );

  app.get<{ Params: ThreadParams }>(
    '/clients/:cnpj/assistant/threads/:thread_id/messages',
    { schema: { params: THREAD_SCHEMA } },
    async (request) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      try {
        const messages = await assistant.messages(scope, request.params.thread_id);
        return { messages, total: messages.length };
      } catch (cause) {
        throw traduzir(cause);
      }
    },
  );

  app.post<{ Params: ThreadParams; Body: { question: string } }>(
    '/clients/:cnpj/assistant/threads/:thread_id/messages',
    {
      schema: {
        params: THREAD_SCHEMA,
        body: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1, maxLength: MAX_CARACTERES_PERGUNTA },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);

      try {
        const { answer, usage } = await assistant.ask(
          scope,
          request.params.thread_id,
          request.body.question,
          request.tenant.user.userId,
        );

        return reply
          .code(201)
          .header('x-assistant-remaining', String(usage.remaining))
          .send({ answer, usage });
      } catch (cause) {
        if (cause instanceof AssistantQuotaError) {
          /**
           * 429 com o limite e o usado no corpo: a tela precisa dizer "você
           * usou X de Y", e não só "limite atingido". É o `429` que o contrato
           * previa desde a Onda 3, e este é o primeiro consumidor dele.
           */
          return reply.code(429).send({
            code: 'assistant_quota_exceeded',
            message: cause.message,
            usage: cause.usage,
          });
        }
        throw traduzir(cause);
      }
    },
  );
}

/**
 * Assistente fora do plano é `403`, não `429`: o primeiro é "não contratado" e o
 * segundo é "acabou o mês". Tratá-los igual mandaria o usuário esperar o mês
 * virar por um recurso que ele nunca teria.
 */
function traduzir(cause: unknown): unknown {
  if (cause instanceof AssistantNotInPlanError) {
    return new ForbiddenError(cause.message);
  }
  if (cause instanceof ThreadNotFoundError) {
    return new NotFoundError(cause.message);
  }
  return cause;
}
