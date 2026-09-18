import { ValueObject } from '../../esaa/shared/domain/value-object.js';
import { BoundaryViolationError } from '../../esaa/shared/types/esaa-errors.js';

interface AgentBoundaryProps {
  readable: readonly string[];
  writable: readonly string[];
  forbidden: readonly string[];
}

/**
 * Fronteira de escrita de um agente fiscal, vinda do `AGENT_CONTRACT.yaml`.
 *
 * `forbidden` tem precedência sobre `writable`: uma pasta proibida continua
 * proibida mesmo dentro de uma permitida.
 */
export class AgentBoundary extends ValueObject<AgentBoundaryProps> {
  private constructor(props: AgentBoundaryProps) {
    super(props);
  }

  static create(
    readable: readonly string[] = [],
    writable: readonly string[] = [],
    forbidden: readonly string[] = [],
  ): AgentBoundary {
    return new AgentBoundary({
      readable: readable.map(normalize),
      writable: writable.map(normalize),
      forbidden: forbidden.map(normalize),
    });
  }

  /** `readable` vazio libera leitura; é o default dos agentes somente-leitura. */
  canRead(path: string): boolean {
    const target = normalize(path);
    if (this.isForbidden(target)) {
      return false;
    }
    return this.props.readable.length === 0 || this.matches(this.props.readable, target);
  }

  /** `writable` vazio **nega** escrita: um agente sem pasta declarada não grava nada. */
  canWrite(path: string): boolean {
    const target = normalize(path);
    if (this.isForbidden(target)) {
      return false;
    }
    return this.matches(this.props.writable, target);
  }

  assertCanWrite(actor: string, path: string): void {
    if (!this.canWrite(path)) {
      throw new BoundaryViolationError(actor, path, 'write');
    }
  }

  private isForbidden(target: string): boolean {
    return this.matches(this.props.forbidden, target);
  }

  /**
   * Compara segmento a segmento, não por `startsWith` de string. O casamento por
   * prefixo textual deixava `docs/specimen` casar com a regra `docs/spec`, e
   * bastava um segmento a mais no nome para uma pasta herdar permissão alheia.
   */
  private matches(rules: readonly string[], target: string): boolean {
    const segments = target.split('/');

    return rules.some((rule) => {
      const ruleSegments = rule.split('/');
      if (ruleSegments.length > segments.length) {
        return false;
      }
      return ruleSegments.every((segment, index) => segment === segments[index]);
    });
  }
}

/**
 * Normaliza separador e remove `.`/`..`, em vez de confiar no caminho recebido.
 * A implementação anterior decidia se era pasta pela presença de um ponto no
 * nome (`!path.includes('.')`), e não tratava `..` — então `src/../.roadmap/x`
 * passava por uma regra que só permitia `src/`.
 */
function normalize(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return resolved.join('/');
}
