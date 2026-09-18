/**
 * Identidade e igualdade por id. A coleta de domain events saiu junto do
 * `EventBus`: o event sourcing real é feito com o envelope `ESAAEventData`
 * gravado pelo orquestrador, e as duas noções de "evento" coexistiam sem
 * nenhuma ligação.
 */
export abstract class Entity<T> {
  protected readonly _id: T;

  constructor(id: T) {
    this._id = id;
  }

  get id(): T {
    return this._id;
  }

  equals(other?: Entity<T>): boolean {
    if (other == null) {
      return false;
    }
    if (this === other) {
      return true;
    }
    return this._id === other._id;
  }
}
