import type { FiscalAction } from '../../../fiscal/shared/fiscal-vocabulary.js';

/**
 * Envelope de um evento do log. Campos fixos para qualquer ação; o que varia
 * fica em `payload`.
 *
 * Escopado por `(tenant_id, cnpj)` — ver ADR-002 e ADR-003.
 */
export interface ESAAEventData {
  event_id: string;
  /**
   * Monotônico e sem gaps **dentro** do par (tenant_id, cnpj), não global.
   */
  event_seq: number;
  action: FiscalAction;
  /**
   * Entidade alvo: competência, chave de acesso, id de item ou o próprio CNPJ.
   * Mantém o nome `task_id` porque é o nome gravado no log desde o início.
   */
  task_id: string;
  /** UUID de usuário, ou nome de agente fiscal. */
  actor: string;
  ts: string;
  schema_version: string;
  /** Escritório dono do evento. Campo de primeira classe, não payload. */
  tenant_id: string;
  /** CNPJ do cliente, 14 dígitos sem máscara. */
  cnpj: string;
  /**
   * Competência `YYYY-MM`, quando o evento pertence a uma. Opcional de
   * propósito: `client.enrolled` e `certificate.stored` são do CNPJ, não de um mês.
   */
  period?: string;
  payload: Record<string, unknown>;
}

/**
 * Uma intenção: o que o chamador pede. Vira evento só se as 7 camadas deixarem.
 *
 * Não carrega `tenant_id` nem `cnpj`: esses vêm do escopo do orquestrador. Se
 * viessem aqui, um cliente poderia pedir escrita no log de outro escritório.
 */
export interface ESAAIntention {
  action: FiscalAction;
  task_id: string;
  actor: string;
  payload: Record<string, unknown>;
  period?: string;
  file_updates?: FileUpdate[];
}

export interface FileUpdate {
  path: string;
  content: string;
}
