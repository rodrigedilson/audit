import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../auth/jwt-verifier.js';
import type { ApiDeps } from '../server.js';

interface LoginBody {
  email: string;
  password: string;
}

interface SupabaseTokenResponse {
  access_token?: string;
  expires_in?: number;
  error_description?: string;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  /**
   * `POST /auth/login` do contrato. Repassa o grant de senha ao Supabase Auth e
   * devolve o token junto do escritório resolvido — o frontend precisa dos dois
   * para montar o painel, e uma ida só evita a tela piscar sem carteira.
   */
  app.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const response = await fetch(`${deps.env.supabase.url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: deps.env.supabase.anonKey,
        },
        body: JSON.stringify({ email, password }),
      });

      const body = (await response.json()) as SupabaseTokenResponse;

      if (!response.ok || !body.access_token) {
        // Mensagem genérica de propósito: distinguir "e-mail não existe" de
        // "senha errada" entrega uma lista de usuários a quem sonda a API.
        throw new UnauthorizedError('E-mail ou senha inválidos.');
      }

      const user = await deps.jwtVerifier.verify(`Bearer ${body.access_token}`);
      const context = await deps.tenantResolver.resolve(user);

      return reply.code(200).send({
        access_token: body.access_token,
        expires_in: body.expires_in ?? 3600,
        tenant: {
          id: context.tenantId,
          name: context.tenantName,
          plan: context.plan,
        },
      });
    },
  );

  /** `GET /me`. O tenant vem de `memberships`, nunca de um claim do token. */
  app.get('/me', async (request, reply) => {
    const context = request.tenant;

    return reply.code(200).send({
      user: {
        id: context.user.userId,
        email: context.user.email ?? null,
        role: context.role,
      },
      tenant: {
        id: context.tenantId,
        name: context.tenantName,
        plan: context.plan,
      },
    });
  });
}
