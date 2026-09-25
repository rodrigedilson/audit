import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../auth/jwt-verifier.js';
import type { ApiDeps } from '../server.js';
import { createBurstLimiter, exigirLimite } from '../plugins/rate-limit.js';

interface LoginBody {
  email: string;
  password: string;
}

interface SupabaseTokenResponse {
  access_token?: string;
  expires_in?: number;
  error_description?: string;
}

/**
 * Tentativas de login: por IP e por e-mail, em duas janelas. Sem isto a rota,
 * que é pública e repassa a senha ao Supabase, servia de oráculo para testar
 * senhas. Por e-mail pega o ataque distribuído contra uma conta; por IP, o que
 * varre muitas contas a partir de um lugar só.
 */
const LOGIN_POR_MINUTO = { windowMs: 60_000, max: 5 };
const LOGIN_POR_HORA = { windowMs: 3_600_000, max: 20 };

export async function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const tentativas = [createBurstLimiter(LOGIN_POR_MINUTO), createBurstLimiter(LOGIN_POR_HORA)];

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
      exigirLimite(
        tentativas,
        [`ip:${request.ip}`, `email:${email.trim().toLowerCase()}`],
        'Muitas tentativas de login. Aguarde antes de tentar de novo.',
      );

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
        // A trilha guarda o HMAC do e-mail, não o e-mail: responde "quantas
        // tentativas contra a mesma conta" sem colecionar endereço de quem pode
        // nem ser usuário.
        deps.securityTrail.registrar({
          kind: 'login_falhou',
          subject: email,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          method: request.method,
          route: '/v1/auth/login',
        });

        // Mensagem genérica de propósito: distinguir "e-mail não existe" de
        // "senha errada" entrega uma lista de usuários a quem sonda a API.
        throw new UnauthorizedError('E-mail ou senha inválidos.');
      }

      const user = await deps.jwtVerifier.verify(`Bearer ${body.access_token}`);
      const context = await deps.tenantResolver.resolve(user);

      // O sucesso também entra: sem ele, a trilha mostra só o que falhou, e uma
      // investigação não consegue dizer se a tentativa que passou foi a décima
      // de um mesmo lugar ou a primeira de um contador legítimo.
      deps.securityTrail.registrar({
        kind: 'login_ok',
        userId: user.userId,
        tenantId: context.tenantId,
        subject: email,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        method: request.method,
        route: '/v1/auth/login',
      });

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
