/**
 * Limitador de rajada, em memória e por processo.
 *
 * É a **primeira** de duas barreiras da rota pública de diagnóstico. A segunda é
 * a quota diária no banco, que atravessa instâncias e reinícios. Esta existe
 * para o caso barato — script ingênuo, duplo-clique, recarregar a página — sem
 * gastar uma ida ao banco.
 *
 * Não usa `@fastify/rate-limit` de propósito: seriam ~70 linhas trocadas por uma
 * dependência a mais num serviço que custodia certificado A1, e a proteção que
 * de fato importa (a quota diária) precisa do banco de qualquer forma.
 */

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface BurstLimiter {
  hit(key: string, now?: number): RateLimitVerdict;
  /** Só para teste: descarta o estado acumulado. */
  reset(): void;
}

/** Erro de limite. O handler o traduz em 429 com `retry_after_seconds`. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number, message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export function createBurstLimiter(rule: RateLimitRule): BurstLimiter {
  // Janela fixa por chave, com os carimbos de tempo das chamadas recentes.
  const janelas = new Map<string, number[]>();

  return {
    hit(key: string, now: number = Date.now()): RateLimitVerdict {
      const inicio = now - rule.windowMs;
      const recentes = (janelas.get(key) ?? []).filter((ts) => ts > inicio);

      if (recentes.length >= rule.max) {
        const maisAntigo = recentes[0]!;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((maisAntigo + rule.windowMs - now) / 1000)),
        };
      }

      recentes.push(now);
      janelas.set(key, recentes);

      // Sem isto o mapa cresce com o número de IPs vistos, que numa rota pública
      // é ilimitado. A varredura é barata porque só roda quando o mapa cresce.
      if (janelas.size > 10_000) {
        for (const [chave, marcas] of janelas) {
          if (marcas.every((ts) => ts <= inicio)) {
            janelas.delete(chave);
          }
        }
      }

      return { allowed: true, retryAfterSeconds: 0 };
    },

    reset(): void {
      janelas.clear();
    },
  };
}
