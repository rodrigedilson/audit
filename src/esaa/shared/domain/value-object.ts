export abstract class ValueObject<T> {
  protected readonly props: T;

  constructor(props: T) {
    this.props = Object.freeze(props);
  }

  public equals(object?: ValueObject<T>): boolean {
    if (object == null) {
      return false;
    }
    if (this === object) {
      return true;
    }
    return JSON.stringify(this.props) === JSON.stringify(object.props);
  }

  get value(): T {
    return this.props;
  }
}
