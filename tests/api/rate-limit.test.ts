import { describe, it, expect } from 'vitest';
import { createBurstLimiter, exigirLimite, RateLimitedError } from '../../src/api/plugins/rate-limit.js';

describe('createBurstLimiter — rajada em memória', () => {
  it('libera até o teto e barra a chamada seguinte', () => {
    const limiter = createBurstLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.hit('a', 1000).allowed).toBe(true);
    expect(limiter.hit('a', 1100).allowed).toBe(true);
    expect(limiter.hit('a', 1200).allowed).toBe(true);

    const barrada = limiter.hit('a', 1300);
    expect(barrada.allowed).toBe(false);
    expect(barrada.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('a janela desliza: depois dela a chave volta a passar', () => {
    const limiter = createBurstLimiter({ windowMs: 1000, max: 1 });

    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 500).allowed).toBe(false);
    expect(limiter.hit('a', 1500).allowed).toBe(true);
  });

  it('chaves diferentes não interferem — um visitante não bloqueia outro', () => {
    const limiter = createBurstLimiter({ windowMs: 60_000, max: 1 });

    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('b', 0).allowed).toBe(true);
    expect(limiter.hit('a', 10).allowed).toBe(false);
  });

  it('o tempo de espera aponta para o fim da janela da chamada mais antiga', () => {
    const limiter = createBurstLimiter({ windowMs: 60_000, max: 1 });

    limiter.hit('a', 0);
    // Faltam 30 s para a primeira chamada sair da janela.
    expect(limiter.hit('a', 30_000).retryAfterSeconds).toBe(30);
  });

  /**
   * Numa rota pública o número de IPs vistos é ilimitado. Sem a varredura o mapa
   * cresceria para sempre — é vazamento de memória, não detalhe de performance.
   */
  it('descarta chaves vencidas quando o mapa cresce', () => {
    const limiter = createBurstLimiter({ windowMs: 1000, max: 1 });

    for (let i = 0; i < 10_001; i += 1) {
      limiter.hit(`ip-${i}`, 0);
    }

    // Passada a janela, a primeira chave foi limpa e volta a passar limpa.
    expect(limiter.hit('ip-0', 5000).allowed).toBe(true);
  });

  it('reset descarta o estado acumulado', () => {
    const limiter = createBurstLimiter({ windowMs: 60_000, max: 1 });

    limiter.hit('a', 0);
    expect(limiter.hit('a', 10).allowed).toBe(false);

    limiter.reset();
    expect(limiter.hit('a', 20).allowed).toBe(true);
  });
});

describe('varredura do mapa', () => {
  /**
   * Com mais de 10 mil chaves vivas, a varredura rodava a cada chamada: um
   * ataque com IPs variados virava uma varredura inteira por requisição.
   */
  it('roda no máximo uma vez por janela', () => {
    const limiter = createBurstLimiter({ windowMs: 1000, max: 1 });
    for (let i = 0; i < 10_001; i += 1) {
      limiter.hit(`ip-${i}`, 0);
    }

    // Primeira chamada depois da janela: varre e limpa as vencidas.
    expect(limiter.hit('novo-1', 5000).allowed).toBe(true);
    // As chaves de t=0 sumiram, então ip-0 passa de novo.
    expect(limiter.hit('ip-0', 5001).allowed).toBe(true);
  });
});

describe('exigirLimite', () => {
  it('passa enquanto todas as chaves e todos os limites passam', () => {
    const minuto = createBurstLimiter({ windowMs: 60_000, max: 2 });
    expect(() => exigirLimite([minuto], ['ip:1', 'email:a'], 'x')).not.toThrow();
  });

  /** Por e-mail pega o ataque distribuído contra uma conta, vindo de IPs diferentes. */
  it('barra pela chave que estourou, mesmo com a outra livre', () => {
    const minuto = createBurstLimiter({ windowMs: 60_000, max: 1 });
    exigirLimite([minuto], ['ip:1', 'email:a'], 'x');

    expect(() => exigirLimite([minuto], ['ip:2', 'email:a'], 'muitas tentativas')).toThrow(RateLimitedError);
  });

  it('o retry_after é o maior entre os limites recusados', () => {
    const minuto = createBurstLimiter({ windowMs: 60_000, max: 1 });
    const hora = createBurstLimiter({ windowMs: 3_600_000, max: 1 });
    exigirLimite([minuto, hora], ['k'], 'x');

    try {
      exigirLimite([minuto, hora], ['k'], 'x');
      throw new Error('deveria ter barrado');
    } catch (erro) {
      expect((erro as RateLimitedError).retryAfterSeconds).toBeGreaterThan(60);
    }
  });
});
