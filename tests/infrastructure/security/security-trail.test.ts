import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { criarTrilhaDeSeguranca } from '../../../src/infrastructure/security/security-trail.js';

const SEGREDO = 'segredo-de-teste-com-tamanho-suficiente';

/** Coleta os parâmetros de cada `insert`, na ordem das colunas da migration. */
function poolEspiao(falhar = false) {
  const chamadas: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      chamadas.push(params);
      if (falhar) {
        throw new Error('banco fora do ar');
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, chamadas };
}

const esperar = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
};

describe('trilha de segurança', () => {
  it('grava o evento com método, rota e tipo', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    trilha.registrar({ kind: 'sem_permissao', method: 'POST', route: '/v1/clients' });
    await esperar();

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]![0]).toBe('sem_permissao');
    expect(chamadas[0]![4]).toBe('POST');
    expect(chamadas[0]![5]).toBe('/v1/clients');
  });

  /**
   * O IP é dado pessoal. O hash liga tentativas entre si sem guardá-lo, e o
   * domínio próprio impede que este hash seja comparado com o do diagnóstico
   * público — cruzar os dois passa a ser decisão, não efeito colateral.
   */
  it('guarda HMAC do IP, nunca o IP', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    trilha.registrar({ kind: 'limite', ip: '203.0.113.10' });
    await esperar();

    const ipHash = chamadas[0]![6] as string;
    expect(ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(chamadas[0])).not.toContain('203.0.113.10');
  });

  /**
   * Uma tentativa falha carrega o e-mail de alguém que pode nem ser usuário —
   * digitação errada, varredura de lista. O hash responde "quantas tentativas
   * contra a mesma conta" sem colecionar endereço de terceiro.
   */
  it('guarda HMAC do e-mail tentado, nunca o e-mail', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    trilha.registrar({ kind: 'login_falhou', subject: 'Contador@Escritorio.com.br' });
    await esperar();

    expect(chamadas[0]![7]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(chamadas[0]).toLowerCase()).not.toContain('contador@');
  });

  it('normaliza o e-mail antes de hashear, para caixa não criar dois alvos', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    trilha.registrar({ kind: 'login_falhou', subject: ' A@B.com ', ip: '1.1.1.1' });
    trilha.registrar({ kind: 'login_falhou', subject: 'a@b.com', ip: '2.2.2.2' });
    await esperar();

    expect(chamadas[0]![7]).toBe(chamadas[1]![7]);
  });

  /**
   * Sem freio, um laço batendo com token inválido escreveria uma linha por
   * requisição: a trilha de segurança viraria o vetor.
   */
  it('freia a rajada da mesma origem e tipo', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    for (let i = 0; i < 50; i++) {
      trilha.registrar({ kind: 'nao_autenticado', ip: '203.0.113.10' });
    }
    await esperar();

    expect(chamadas.length).toBeLessThan(50);
    expect(chamadas.length).toBeGreaterThan(0);
  });

  /** O freio de um tipo não pode esconder outro acontecendo ao mesmo tempo. */
  it('o freio é por tipo, não por origem apenas', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    for (let i = 0; i < 50; i++) {
      trilha.registrar({ kind: 'nao_autenticado', ip: '203.0.113.10' });
    }
    trilha.registrar({ kind: 'sem_permissao', ip: '203.0.113.10' });
    await esperar();

    expect(chamadas.some((c) => c[0] === 'sem_permissao')).toBe(true);
  });

  /**
   * Gravar auditoria é importante; recusar atender porque a auditoria falhou
   * seria pior. Mas perder a linha em silêncio é que não pode.
   */
  it('não lança quando o banco falha, e avisa quem registra', async () => {
    const { pool } = poolEspiao(true);
    const aoFalhar = vi.fn();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, aoFalhar);

    expect(() => trilha.registrar({ kind: 'limite', ip: '1.2.3.4' })).not.toThrow();
    await esperar();

    expect(aoFalhar).toHaveBeenCalledOnce();
    expect(aoFalhar.mock.calls[0]![0]).toMatch(/trilha de segurança/);
  });

  /** É o campo que liga a trilha ao log e ao `x-request-id` da resposta. */
  it('grava o id da requisição', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    trilha.registrar({ kind: 'limite', requestId: 'req-123' });
    await esperar();

    expect(chamadas[0]![10]).toBe('req-123');
  });

  it('corta texto livre, que pode vir enorme', async () => {
    const { pool, chamadas } = poolEspiao();
    const trilha = criarTrilhaDeSeguranca(pool, SEGREDO, () => undefined);

    trilha.registrar({ kind: 'limite', userAgent: 'x'.repeat(5_000) });
    await esperar();

    expect((chamadas[0]![8] as string).length).toBe(200);
  });
});
