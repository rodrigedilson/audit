import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../../config/env.js';

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export interface AuthenticatedUser {
  userId: string;
  email?: string;
}

/**
 * Verifica o JWT emitido pelo Supabase Auth.
 *
 * Aceita HS256 com o JWT secret do projeto ou chaves assimétricas via JWKS. Só
 * o `sub` é confiável para identidade: o tenant **não** é lido do token e sim
 * resolvido contra a tabela `memberships`, porque um claim customizado pode
 * ficar velho depois de um usuário sair do escritório, e uma sessão antiga
 * continuaria dando acesso.
 */
export class JwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  private readonly secret: Uint8Array | undefined;

  constructor(private readonly env: Env) {
    if (env.supabase.jwksUrl) {
      this.jwks = createRemoteJWKSet(new URL(env.supabase.jwksUrl));
    }
    if (env.supabase.jwtSecret) {
      this.secret = new TextEncoder().encode(env.supabase.jwtSecret);
    }
  }

  async verify(authorizationHeader: string | undefined): Promise<AuthenticatedUser> {
    const token = extractBearer(authorizationHeader);

    let payload: JWTPayload;
    try {
      payload = this.jwks
        ? (await jwtVerify(token, this.jwks, { audience: this.env.supabase.audience })).payload
        : (await jwtVerify(token, this.secret!, { audience: this.env.supabase.audience })).payload;
    } catch (cause) {
      // A causa não vai para a resposta: distinguir "assinatura inválida" de
      // "expirado" para um chamador não autenticado é informação de graça.
      throw new UnauthorizedError('Token inválido ou expirado.');
    }

    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (userId.length === 0) {
      throw new UnauthorizedError('Token sem identificação de usuário (claim sub).');
    }

    const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
    return email === undefined ? { userId } : { userId, email };
  }
}

function extractBearer(header: string | undefined): string {
  if (!header) {
    throw new UnauthorizedError('Cabeçalho Authorization ausente.');
  }

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new UnauthorizedError('Cabeçalho Authorization deve ser "Bearer <token>".');
  }

  return token;
}
