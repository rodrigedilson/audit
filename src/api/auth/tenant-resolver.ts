import type { Pool } from 'pg';
import { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { AuthenticatedUser } from './jwt-verifier.js';

export type MembershipRole = 'owner' | 'accountant' | 'viewer';

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  plan: string;
  role: MembershipRole;
  user: AuthenticatedUser;
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Traduz "usuário autenticado" em "usuário autenticado **neste** escritório, com
 * este papel" — e, quando a rota é de um CNPJ, em um `EventScope` já verificado.
 *
 * É aqui que o isolamento entre tenants é decidido. O tenant vem da tabela
 * `memberships`, nunca de um claim do token: um claim fica velho quando o
 * usuário sai do escritório, e uma sessão antiga continuaria valendo. Ver
 * ADR-002.
 */
export class TenantResolver {
  constructor(private readonly pool: Pool) {}

  /** Resolve a associação do usuário. Um usuário sem associação não tem tenant. */
  async resolve(user: AuthenticatedUser): Promise<TenantContext> {
    const { rows } = await this.pool.query<{
      tenant_id: string;
      name: string;
      plan: string;
      role: MembershipRole;
    }>(
      `select t.id as tenant_id, t.name, t.plan, m.role
         from memberships m
         join tenants t on t.id = m.tenant_id
        where m.user_id = $1::uuid
        order by m.created_at asc
        limit 1`,
      [user.userId],
    );

    const membership = rows[0];
    if (!membership) {
      throw new ForbiddenError('Usuário não pertence a nenhum escritório.');
    }

    return {
      tenantId: membership.tenant_id,
      tenantName: membership.name,
      plan: membership.plan,
      role: membership.role,
      user,
    };
  }

  /**
   * Devolve o escopo de escrita para um CNPJ, provando antes que ele pertence a
   * este tenant.
   *
   * Responde 404 e não 403 quando o CNPJ existe em outro escritório: um 403
   * confirmaria ao chamador que aquele CNPJ está cadastrado na plataforma, o que
   * é vazamento de informação entre concorrentes — e a carteira de um escritório
   * é informação comercial sensível.
   */
  async scopeFor(context: TenantContext, cnpj: string): Promise<EventScope> {
    const scope = EventScope.create(context.tenantId, cnpj);

    const { rows } = await this.pool.query<{ exists: boolean }>(
      `select true as exists from clients
        where tenant_id = $1::uuid and cnpj = $2::char(14) limit 1`,
      [scope.tenantId, scope.cnpj],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`CNPJ ${scope.cnpj} não encontrado nesta carteira.`);
    }

    return scope;
  }

  /** Papéis que podem escrever. `viewer` lê a carteira e não altera nada. */
  assertCanWrite(context: TenantContext): void {
    if (context.role === 'viewer') {
      throw new ForbiddenError('Perfil "viewer" não pode alterar dados fiscais.');
    }
  }

  /** Só o `owner` mexe em cadastro de empresa, certificado e cobrança. */
  assertIsOwner(context: TenantContext): void {
    if (context.role !== 'owner') {
      throw new ForbiddenError('Apenas o perfil "owner" pode executar esta operação.');
    }
  }
}
