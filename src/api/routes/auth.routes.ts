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

  /**
   * Quem tem acesso a este escritório, e com que papel.
   *
   * Leitura, e só. Convidar, remover e trocar papel não existem na API — hoje
   * isso se faz direto no banco. A tela precisa dizer isso em vez de mostrar
   * botões que não levam a lugar nenhum.
   *
   * Qualquer membro lista: saber quem mais tem acesso ao escritório não é
   * informação sensível dentro dele, e é o que permite a um `viewer` saber a
   * quem pedir uma operação que ele não pode fazer.
   */
  app.get('/users', async (request, reply) => {
    const context = request.tenant;

    /**
     * O e-mail mora em `auth.users`, que é do Supabase.
     *
     * O schema `auth` não existe num Postgres puro — CI e desenvolvimento local
     * —, e por isso o join é condicional: `to_regclass` devolve nulo lá, e a
     * consulta cai no ramo sem e-mail em vez de quebrar. Sem isso, esta rota
     * funcionaria em produção e derrubaria a suíte.
     */
    const { rows: existe } = await deps.pool.query<{ tem: boolean }>(
      "select to_regclass('auth.users') is not null as tem",
    );
    const comEmail = existe[0]?.tem === true;

    const { rows } = await deps.pool.query<{
      user_id: string;
      role: string;
      created_at: Date;
      email: string | null;
    }>(
      comEmail
        ? `select m.user_id, m.role::text as role, m.created_at, u.email
             from memberships m
             left join auth.users u on u.id = m.user_id
            where m.tenant_id = $1::uuid
            order by m.created_at`
        : `select m.user_id, m.role::text as role, m.created_at, null::text as email
             from memberships m
            where m.tenant_id = $1::uuid
            order by m.created_at`,
      [context.tenantId],
    );

    return reply.code(200).send({
      users: rows.map((row) => ({
        user_id: row.user_id,
        email: row.email,
        role: row.role,
        created_at: row.created_at.toISOString(),
        /** Quem está lendo. A tela marca a própria linha. */
        is_you: row.user_id === context.user.userId,
      })),
      total: rows.length,
      /**
       * `false` diz que a lista não traz e-mail porque a fonte não está
       * disponível — e não que os usuários não têm e-mail.
       */
      emails_available: comEmail,
      /** Nenhuma rota de convite, remoção ou troca de papel existe ainda. */
      management_available: false,
    });
  });
}
