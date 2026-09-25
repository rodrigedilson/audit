/** Pedido recusado antes de enfileirar — 409 ou 429 na API. */
export class DfeSyncRefusedError extends Error {
  constructor(
    message: string,
    readonly kind: 'no_certificate' | 'certificate_not_usable' | 'missing_uf' | 'blocked',
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = 'DfeSyncRefusedError';
  }
}
