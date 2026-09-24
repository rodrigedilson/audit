import { describe, it, expect } from 'vitest';
import { createBurstLimiter } from '../../src/api/plugins/rate-limit.js';

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
