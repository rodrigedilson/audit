import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import pg from 'pg';
import type { Env } from '../config/env.js';
import { JwtVerifier } from './auth/jwt-verifier.js';
import { TenantResolver, type TenantContext } from './auth/tenant-resolver.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerPortfolioRoutes } from './routes/portfolio.routes.js';
import { registerEventRoutes } from './routes/events.routes.js';

export interface ApiDeps {
  env: Env;
  pool: pg.Pool;
  jwtVerifier: JwtVerifier;
  tenantResolver: TenantResolver;
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
const PUBLIC_ROUTES = new Set(['/v1/auth/login', '/v1/health']);

export interface BuildServerOptions {
  env: Env;
  pool?: pg.Pool;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { env } = options;
  const pool = options.pool ?? new pg.Pool({ connectionString: env.databaseUrl });

  const deps: ApiDeps = {
    env,
    pool,
    jwtVerifier: new JwtVerifier(env),
    tenantResolver: new TenantResolver(pool),
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
