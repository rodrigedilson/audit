import { ValueObject } from '../../../shared/domain/value-object.js';

interface EventScopeProps {
  tenantId: string;
  cnpj: string;
}

/**
 * Escopo de um event log. Todo evento pertence a um par (tenant, CNPJ), e a
 * sequência `event_seq` é monotônica **dentro** desse par — nunca global, senão
 * dois escritórios disputariam a mesma sequência e dois CNPJs do mesmo escritório
 * não poderiam fechar em paralelo. Ver ADR-002 e ADR-003.
 */
export class EventScope extends ValueObject<EventScopeProps> {
  private constructor(props: EventScopeProps) {
    super(props);
  }

  static create(tenantId: string, cnpj: string): EventScope {
    const normalizedTenant = tenantId?.trim() ?? '';
    if (normalizedTenant.length === 0) {
      throw new Error('EventScope: tenant_id não pode ser vazio');
    }

    const normalizedCnpj = onlyDigits(cnpj ?? '');
    if (normalizedCnpj.length !== 14) {
      throw new Error(
        `EventScope: cnpj deve ter 14 dígitos sem máscara, recebido '${String(cnpj)}'`,
      );
    }

    return new EventScope({ tenantId: normalizedTenant, cnpj: normalizedCnpj });
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get cnpj(): string {
    return this.props.cnpj;
  }

  /**
   * Chave de serialização de escrita. Alimenta o `pg_advisory_xact_lock` que
   * implementa o single-writer por CNPJ (INV-005), e a partição do log.
   */
  toKey(): string {
    return `${this.props.tenantId}:${this.props.cnpj}`;
  }

  toString(): string {
    return this.toKey();
  }
}

/**
 * O contrato exige CNPJ com 14 dígitos sem máscara, mas aceitar a máscara aqui e
 * normalizar evita que um `12.345.678/0001-95` colado da tela vire um escopo
 * distinto do mesmo CNPJ — o que fragmentaria o log de um cliente em dois.
 */
function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}
