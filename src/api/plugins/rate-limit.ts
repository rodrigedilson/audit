/**
 * Limitador de rajada, em memória e por processo.
 *
 * Protege as rotas sem dono ou de tentativa: o diagnóstico público (junto da
 * quota diária no banco, que atravessa instâncias e reinícios), o login e a
 * calculadora de preço. Em memória basta enquanto a API roda numa instância
 * só; com mais de uma, cada uma conta a sua parte, e o limite efetivo
 * multiplica pelo número de instâncias.
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
  // Janela deslizante por chave, com os carimbos de tempo das chamadas recentes.
  const janelas = new Map<string, number[]>();
  let proximaVarredura = 0;

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
      // é ilimitado. A varredura roda no máximo uma vez por janela: antes ela
      // rodava a cada chamada enquanto houvesse mais de 10 mil chaves vivas, e
      // um ataque com IPs variados virava uma varredura inteira por requisição.
      if (janelas.size > 10_000 && now >= proximaVarredura) {
        proximaVarredura = now + rule.windowMs;
        for (const [chave, marcas] of janelas) {
          if (marcas[marcas.length - 1]! <= inicio) {
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

/**
 * Conta a chamada em cada limitador, para cada chave, e lança `RateLimitedError`
 * na primeira recusa. O `retry_after` é o maior entre os recusados.
 */
export function exigirLimite(
  limites: readonly BurstLimiter[],
  chaves: readonly string[],
  mensagem: string,
): void {
  let espera = 0;
  for (const limite of limites) {
    for (const chave of chaves) {
      const veredito = limite.hit(chave);
      if (!veredito.allowed) {
        espera = Math.max(espera, veredito.retryAfterSeconds);
      }
    }
  }
  if (espera > 0) {
    throw new RateLimitedError(espera, mensagem);
  }
}
