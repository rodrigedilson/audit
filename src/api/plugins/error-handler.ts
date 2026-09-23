import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../auth/jwt-verifier.js';
import { ForbiddenError, NotFoundError } from '../auth/tenant-resolver.js';
import { BillingSettingsMissingError } from '../../billing/billing.service.js';
import {
  ESAAError,
  IntegrityViolationError,
  ValidationError,
} from '../../esaa/shared/types/esaa-errors.js';

/**
 * Traduz erros de domínio nas duas formas de resposta do contrato: `Error`
 * (`code` + `message`) e `Rejection` (`layer`, `reason`, `rejection_event_seq`).
 *
 * Mensagens em PT-BR, identificadores em inglês, como o contrato define.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof UnauthorizedError) {
      return reply.code(401).send({ code: 'unauthorized', message: error.message });
    }

    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ code: 'forbidden', message: error.message });
    }

    if (error instanceof NotFoundError) {
      return reply.code(404).send({ code: 'not_found', message: error.message });
    }

    // Configuração do servidor, não erro do cliente: 503 diz "tente depois" e
    // não esconde a causa atrás de um 500 genérico.
    if (error instanceof BillingSettingsMissingError) {
      request.log.error({ err: error }, 'billing_settings ausente');
      return reply.code(503).send({ code: 'billing_not_configured', message: error.message });
    }

    // Intenção barrada por uma das 7 camadas: 422, com a camada e o motivo, para
    // o frontend poder mostrar ao contador onde o documento falhou.
    if (error instanceof ValidationError) {
      return reply.code(422).send({
        rejected: true,
        layer: error.layer,
        reason: error.reason,
        message: error.message,
        details: { details: error.details },
      });
    }

    // A projeção deixou de fechar com o event log. É 409 e não 500: o pedido era
    // legítimo, o estado é que não permite concluir com trilha íntegra.
    if (error instanceof IntegrityViolationError) {
      request.log.error(
        { expectedHash: error.expectedHash, actualHash: error.actualHash },
        'integridade da projeção violada',
      );
      return reply.code(409).send({
        rejected: true,
        layer: 7,
        reason: 'verification_mismatch',
        message:
          'A projeção não fecha com o event log. A competência foi posta em quarentena ' +
          'e nenhum número deve ser considerado válido até a verificação passar.',
      });
    }

    if (error instanceof ESAAError) {
      request.log.error({ err: error, code: error.code }, 'erro de domínio');
      return reply.code(409).send({ code: error.code, message: error.message });
    }

    // Validação de schema do próprio Fastify (path, query, body).
    if (error.validation) {
      return reply.code(400).send({
        code: 'bad_request',
        message: 'Requisição inválida.',
        details: error.validation,
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // O detalhe fica no log, não na resposta: mensagem de erro interno é
      // superfície de reconhecimento para quem está sondando a API.
      request.log.error({ err: error }, 'erro não tratado');
      return reply.code(status).send({ code: 'internal_error', message: 'Erro interno.' });
    }

    return reply.code(status).send({ code: 'request_error', message: error.message });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(404)
      .send({ code: 'not_found', message: `Rota não encontrada: ${request.method} ${request.url}` });
  });
}
