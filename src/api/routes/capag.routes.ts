import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { createBurstLimiter, RateLimitedError } from '../plugins/rate-limit.js';
import { PublicInputError } from '../public-errors.js';
import { PADRAO_DE_CNPJ } from './cnpj-param.js';
import { CapagExtractorNotConfiguredError } from '../../fiscal/forensics/capag/capag.service.js';
import { DocumentTextError } from '../../fiscal/forensics/capag/document-text.js';

/** Um demonstrativo por upload, até 5 MB: o do REGULARIZE tem poucas páginas. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Cada upload chama o modelo, e custa. Dez por hora por escritório cobre a
 * rotina de conferir a carteira sem deixar um laço qualquer virar conta.
 */
const LIMITE = { windowMs: 3_600_000, max: 10 };

const CNPJ_PARAM = {
  type: 'object',
  required: ['cnpj'],
  properties: { cnpj: { type: 'string', pattern: PADRAO_DE_CNPJ } },
} as const;

/**
 * CAPAG presumida do CNPJ: o demonstrativo do REGULARIZE, extraído e conferido,
 * e a fórmula de referência ao lado: a oficial da PGFN, conferida, quando
 * carregada, e senão a de doutrina, não conferida.
 *
 * Feature `capag`, nos planos que já incluem o assistente fiscal (Simples
 * híbrido para cima): cada demonstrativo é uma chamada ao modelo. O controle é
 * do `plan-gate`, como nas outras rotas fechadas por plano.
 */
export async function registerCapagRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const limite = createBurstLimiter(LIMITE);

  app.post<{ Params: { cnpj: string } }>(
    '/clients/:cnpj/capag/statements',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const context = request.tenant;
      deps.tenantResolver.assertCanWrite(context);
      const scope = await deps.tenantResolver.scopeFor(context, request.params.cnpj);

      if (!deps.capag.configured) {
        return reply.code(503).send({
          code: 'capag_extractor_not_configured',
          message: new CapagExtractorNotConfiguredError().message,
        });
      }

      let bytes: Buffer | undefined;
      let contentType: string | null = null;
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          bytes = await part.toBuffer();
          contentType = part.mimetype ?? null;
        }
      }
      if (bytes === undefined || bytes.length === 0) {
        throw new PublicInputError('Envie o demonstrativo no campo "file" (PDF ou HTML).');
      }
      if (bytes.length > MAX_BYTES) {
        throw new PublicInputError('O demonstrativo passa de 5 MB.');
      }

      const veredito = limite.hit(context.tenantId);
      if (!veredito.allowed) {
        throw new RateLimitedError(veredito.retryAfterSeconds, 'Muitos demonstrativos seguidos. Aguarde e envie de novo.');
      }

      try {
        const statement = await deps.capag.importStatement({
          scope,
          orchestrator: await deps.orchestratorFor(scope),
          actor: context.user.userId,
          bytes: new Uint8Array(bytes),
          contentType,
        });
        return reply.code(201).send({ cnpj: scope.cnpj, statement });
      } catch (erro) {
        if (erro instanceof DocumentTextError) throw new PublicInputError(erro.message);
        throw erro;
      }
    },
  );

  app.get<{ Params: { cnpj: string } }>(
    '/clients/:cnpj/capag',
    { schema: { params: CNPJ_PARAM } },
    async (request, reply) => {
      const scope = await deps.tenantResolver.scopeFor(request.tenant, request.params.cnpj);
      const [statement, references] = await Promise.all([deps.capag.latest(scope), deps.capag.references()]);
      return reply.code(200).send({
        cnpj: scope.cnpj,
        extractor_configured: deps.capag.configured,
        /** O último demonstrativo, com a conferência. `null` quando nenhum foi enviado. */
        statement,
        /**
         * Fórmula lida em fonte pública, por grupo. Conferida só a da página
         * oficial da PGFN; a de doutrina vem como referência, não conferida.
         */
        reference_formulas: references,
      });
    },
  );
}
