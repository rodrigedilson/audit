import { createHash } from 'node:crypto';

export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Serializa `value` como JSON canônico determinístico (espírito do JCS / RFC 8785):
 * chaves de objeto ordenadas lexicograficamente em **todos** os níveis, ordem de
 * array preservada (é significativa) e nenhum espaço.
 *
 * A implementação anterior era `JSON.stringify(obj, Object.keys(obj).sort())`, que
 * não faz isso: o segundo argumento em forma de array é um *allowlist de chaves
 * aplicado recursivamente*, não um ordenador. Como só as chaves de topo entravam na
 * lista, todo objeto aninhado serializava vazio e o hash ficava cego a qualquer
 * mudança abaixo do primeiro nível — inclusive ao estado das tasks e aos totais.
 * Ver ADR-005.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function hashProjection(projection: unknown): string {
  return sha256(canonicalize(projection));
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'object':
      return serializeContainer(value as object, ancestors);
    case 'bigint':
      throw new TypeError('canonicalize: bigint não tem representação em JSON');
    default:
      // undefined, function e symbol não têm representação própria; dentro de um
      // array o JSON.stringify os emite como null, e é o que espelhamos aqui.
      return 'null';
  }
}

/**
 * Rejeita não-finitos em vez de emitir `null` como o `JSON.stringify` faria. Um NaN
 * ou Infinity numa projeção fiscal é um defeito de cálculo, e silenciá-lo dentro do
 * hash que serve de trilha de auditoria esconderia exatamente o que o hash existe
 * para provar.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`canonicalize: número não finito na projeção (${String(value)})`);
  }
  // `String` já produz a menor representação com round-trip garantido.
  return String(value === 0 ? 0 : value);
}

function serializeContainer(container: object, ancestors: Set<object>): string {
  const lowered = applyToJSON(container);
  if (lowered !== container) {
    return serialize(lowered, ancestors);
  }

  if (ancestors.has(container)) {
    throw new TypeError('canonicalize: referência circular na projeção');
  }

  ancestors.add(container);
  const json = Array.isArray(container)
    ? serializeArray(container, ancestors)
    : serializeObject(container as Record<string, unknown>, ancestors);
  ancestors.delete(container);

  return json;
}

/** Honra `toJSON()` como o `JSON.stringify` faz — é o que torna `Date` estável. */
function applyToJSON(container: object): unknown {
  const candidate = (container as { toJSON?: unknown }).toJSON;
  if (typeof candidate !== 'function') {
    return container;
  }
  return (candidate as () => unknown).call(container);
}

function serializeArray(items: readonly unknown[], ancestors: Set<object>): string {
  const parts = items.map((item) => serialize(item, ancestors));
  return `[${parts.join(',')}]`;
}

function serializeObject(entries: Record<string, unknown>, ancestors: Set<object>): string {
  const keys = Object.keys(entries)
    .filter((key) => hasJsonRepresentation(entries[key]))
    .sort();

  const parts = keys.map((key) => `${JSON.stringify(key)}:${serialize(entries[key], ancestors)}`);

  return `{${parts.join(',')}}`;
}

/** Chaves cujo valor é `undefined`, função ou symbol são omitidas, como no JSON.stringify. */
function hasJsonRepresentation(value: unknown): boolean {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}
