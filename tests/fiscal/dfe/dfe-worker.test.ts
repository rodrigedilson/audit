import { describe, it, expect } from 'vitest';
import { startDfeWorker } from '../../../src/fiscal/dfe/dfe-worker.js';
import type { DfeSyncService } from '../../../src/fiscal/dfe/dfe-sync.service.js';

/** Serviço dublado: uma fila de ids, e `null` quando acaba. */
function servico(fila: (string | null | Error)[]): { service: DfeSyncService; chamadas: () => number } {
  let n = 0;
  const service = {
    runNext: async () => {
      n += 1;
      const proximo = fila.shift() ?? null;
      if (proximo instanceof Error) throw proximo;
      return proximo;
    },
  } as unknown as DfeSyncService;
  return { service, chamadas: () => n };
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startDfeWorker', () => {
  it('esvazia a fila num tique e para quando ela acaba', async () => {
    const { service, chamadas } = servico(['a', 'b', null]);
    const worker = startDfeWorker(service, { intervalMs: 5 });

    await esperar(30);
    await worker.stop();

    expect(chamadas()).toBeGreaterThanOrEqual(3);
  });

  it('respeita o teto por tique', async () => {
    const { service, chamadas } = servico(['a', 'b', 'c', 'd']);
    const worker = startDfeWorker(service, { intervalMs: 1000, maxPorTique: 2 });

    await worker.stop();
    expect(chamadas()).toBe(0);

    const segundo = servico(['a', 'b', 'c', 'd']);
    const w2 = startDfeWorker(segundo.service, { intervalMs: 5, maxPorTique: 2 });
    await esperar(8);
    await w2.stop();
    expect(segundo.chamadas()).toBeLessThanOrEqual(4);
  });

  /** Erro de um tique não derruba o worker: o job que falhou já foi marcado pelo serviço. */
  it('erro num tique não para o worker', async () => {
    const erros: unknown[] = [];
    const { service, chamadas } = servico([new Error('rede'), 'a', null]);
    const worker = startDfeWorker(service, { intervalMs: 5, onError: (e) => erros.push(e) });

    await esperar(40);
    await worker.stop();

    expect(erros).toHaveLength(1);
    expect(chamadas()).toBeGreaterThanOrEqual(3);
  });
});
