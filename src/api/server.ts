import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import type { Env } from '../config/env.js';
import { JwtVerifier } from './auth/jwt-verifier.js';
import { TenantResolver, type TenantContext } from './auth/tenant-resolver.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerPortfolioRoutes } from './routes/portfolio.routes.js';
import { registerEventRoutes } from './routes/events.routes.js';
import { registerCertificateRoutes } from './routes/certificate.routes.js';
import { registerBillingRoutes, registerBillingWebhook } from './routes/billing.routes.js';
import { AsaasClient } from '../billing/asaas-client.js';
import { FiscalOrchestratorService } from '../esaa/orchestrator/fiscal-orchestrator.service.js';
import { ContractLoaderService } from '../esaa/core/contracts/contract-loader.service.js';
import { PostgresEventStoreRepository } from '../infrastructure/persistence/postgres-event-store.repository.js';
import type { EventScope } from '../esaa/core/event-store/value-objects/event-scope.vo.js';
import { loadConfig } from '../config/esaa-config.js';

export interface ApiDeps {
  env: Env;
  pool: pg.Pool;
  jwtVerifier: JwtVerifier;
  tenantResolver: TenantResolver;
  /**
   * Um orquestrador por escopo de requisição. Não é cache: a projeção em memória
   * é do CNPJ que ele serve, e compartilhá-la entre requisições concorrentes
   * faria duas apurações trabalharem sobre o mesmo objeto mutável.
   */
  orchestratorFor: (scope: EventScope) => Promise<FiscalOrchestratorService>;
  /**
   * Ausente quando `ASAAS_API_KEY` não está configurada. A cobrança então roda
   * em modo "só cálculo": planos, calculadora e prévia de fatura funcionam, e
   * nada é enviado ao gateway. É o que permite operar as primeiras ondas sem
   * credencial de pagamento.
   */
  asaas?: AsaasClient;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Preenchido pelo hook de autenticação. Sempre presente nas rotas
     * autenticadas, e as públicas não o leem.
     */
    tenant: TenantContext;
  }
}

/** Rotas sem autenticação. Tudo o mais exige token e associação a um escritório. */
const PUBLIC_ROUTES = new Set([
  '/v1/auth/login',
  '/v1/health',
  // Preço público antes de qualquer contato comercial — ver briefing.
  '/v1/plans',
  '/v1/price-calculator',
  // Autenticado por token do gateway, não por JWT: o Asaas não tem sessão.
  '/v1/webhooks/asaas',
]);

export interface BuildServerOptions {
  env: Env;
  pool?: pg.Pool;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { env } = options;
  const pool = options.pool ?? new pg.Pool({ connectionString: env.databaseUrl });

  // O contrato de agentes é carregado uma vez, no start: relê-lo por requisição
  // seria I/O de disco no caminho quente, e ele não muda em runtime.
  const config = await loadConfig();
  const contractLoader = new ContractLoaderService();
  await contractLoader.loadAgentContract(config.contracts.agentContract);

  const deps: ApiDeps = {
    env,
    pool,
    jwtVerifier: new JwtVerifier(env),
    tenantResolver: new TenantResolver(pool),
    ...(env.asaas === undefined
      ? {}
      : { asaas: new AsaasClient({ apiKey: env.asaas.apiKey, baseUrl: env.asaas.baseUrl }) }),
    orchestratorFor: async (scope) => {
      const orchestrator = new FiscalOrchestratorService(
        new PostgresEventStoreRepository(pool, scope),
        contractLoader,
        scope,
      );
      await orchestrator.initialize();
      return orchestrator;
    },
  };

  const app = Fastify({
    logger: {
      level: env.logLevel,
      // Authorization nunca entra no log: um token vazado em arquivo de log é um
      // token vazado.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  registerErrorHandler(app);

  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
  });

  // Limite no upload do PFX e nos campos: um multipart sem teto é vetor de carga.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 },
  });

  app.get('/v1/health', async () => ({ status: 'ok' }));

  /**
   * Autenticação por hook global, não por rota: rota nova nasce protegida, e
   * esquecer de adicionar um `preHandler` não cria um vazamento silencioso. O
   * custo é manter `PUBLIC_ROUTES` explícito.
   */
  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) {
      return;
    }

    const user = await deps.jwtVerifier.verify(request.headers.authorization);
    request.tenant = await deps.tenantResolver.resolve(user);
  });

  await app.register(
    async (instance) => {
      await registerAuthRoutes(instance, deps);
      await registerPortfolioRoutes(instance, deps);
      await registerEventRoutes(instance, deps);
      await registerCertificateRoutes(instance, deps);
      await registerBillingRoutes(instance, deps);
      await registerBillingWebhook(instance, deps);
    },
    { prefix: '/v1' },
  );

  app.addHook('onClose', async () => {
    if (!options.pool) {
      await pool.end();
    }
  });

  return app;
}
