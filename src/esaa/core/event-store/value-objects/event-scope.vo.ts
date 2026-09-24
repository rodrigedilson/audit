import { ValueObject } from '../../../shared/domain/value-object.js';
import { TAMANHO_DO_CNPJ, normalizarCnpj } from '../../../shared/domain/cnpj.js';

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

    const normalizedCnpj = normalizarCnpj(cnpj ?? '');
    if (!FORMATO_DO_CNPJ.test(normalizedCnpj)) {
      throw new Error(
        `EventScope: cnpj deve ter ${TAMANHO_DO_CNPJ} posições — 12 alfanuméricas e ` +
          `2 dígitos verificadores numéricos. Recebido '${String(cnpj)}'`,
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
 * Formato, e **não** dígito verificador.
 *
 * O DV é conferido na fronteira, quando o CNPJ entra no sistema — cadastro de
 * cliente, importação de escrituração. Aqui não: o `EventScope` também é
 * construído ao **ler** o log, e um CNPJ que entrou torto algum dia ficaria
 * ilegível para sempre. Seria transformar um problema de qualidade de dado em
 * indisponibilidade, e o log é append-only: não há como corrigir o passado.
 *
 * Desde 31/07/2026 as 12 primeiras posições podem ter letras (CNPJ
 * alfanumérico); as duas últimas seguem numéricas.
 */
const FORMATO_DO_CNPJ = /^[0-9A-Z]{12}[0-9]{2}$/;
