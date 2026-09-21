import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { SimulationService } from '../../../src/fiscal/simulation/simulation.service.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';

const SCOPE = EventScope.create('11111111-1111-1111-1111-111111111111', '12345678000195');

const MEDICAO = {
  saida: '12000000',
  entrada: '4000000',
  saida_pj: '6000000',
  documentos: '240',
  meses: '12',
};

const GRAVACAO = { id: 'aaaaaaaa-0000-0000-0000-000000000000', simulated_at: '2027-07-01T00:00:00Z' };

/**
 * Pool dublado, por ordem de chamada.
 *
 * `tax_rules` é dado normativo **global** e o arquivo de teste da apuração dual
 * apaga a tabela no seu `beforeEach`; os arquivos rodam em paralelo. Semear
 * alíquotas publicadas num teste de integração faria os dois brigarem de forma
 * intermitente, então o caminho da regra publicada é testado aqui.
 */
function poolDeFila(...resultados: Record<string, unknown>[][]): Pool {
  const fila = [...resultados];
  return {
    query: async () => ({ rows: fila.shift() ?? [] }),
  } as unknown as Pool;
}

import type { Assumption } from '../../../src/fiscal/simulation/regime-simulation.js';

const premissa = (r: { result: { assumptions: Assumption[] } }, key: string): Assumption =>
  r.result.assumptions.find((a) => a.key === key)!;

const pedido = {
  scenario: 'full_2033' as const,
  base_from: '2027-01',
  base_to: '2027-12',
};

describe('serviço de simulação — origem da alíquota', () => {
  /**
   * `tax_rules` nasce vazia de propósito (Onda 6). O normal é a alíquota ser
   * premissa informada, e o relatório tem de dizer isso.
   */
  it('sem regra publicada, a alíquota sai como premissa informada', async () => {
    const service = new SimulationService(poolDeFila([MEDICAO], [], [GRAVACAO]));

    const r = await service.run(SCOPE, pedido, null);

    expect(premissa(r, 'ibs_cbs_rate').origin).toBe('provided');
  });

  /**
   * A alíquota conjunta é a soma das três publicadas. Só vale como publicada se
   * **todas** existirem: somar duas daria um número menor com cara de completo.
   */
  it('com as três alíquotas publicadas, soma e marca como publicada', async () => {
    const service = new SimulationService(
      poolDeFila(
        [MEDICAO],
        [
          { tax: 'ibs_uf', value: '10.5', source: 'Res. CGIBS fictícia' },
          { tax: 'ibs_mun', value: '2.5', source: 'Res. CGIBS fictícia' },
          { tax: 'cbs', value: '9.0', source: 'Lei fictícia' },
        ],
        [GRAVACAO],
      ),
    );

    const r = await service.run(SCOPE, pedido, null);
    const aliquota = premissa(r, 'ibs_cbs_rate');

    expect(aliquota.origin).toBe('published');
    expect(aliquota.value).toBe(22);
    expect(aliquota.source).toContain('Res. CGIBS fictícia');
    expect(aliquota.source).toContain('Lei fictícia');
  });

  it.each([1, 2])(
    'com apenas %i alíquota(s) publicada(s), volta a ser premissa informada',
    async (quantas) => {
      const publicadas = [
        { tax: 'ibs_uf', value: '10.5', source: 'x' },
        { tax: 'ibs_mun', value: '2.5', source: 'x' },
      ].slice(0, quantas);

      const service = new SimulationService(poolDeFila([MEDICAO], publicadas, [GRAVACAO]));

      const r = await service.run(SCOPE, pedido, null);

      expect(premissa(r, 'ibs_cbs_rate').origin).toBe('provided');
    },
  );

  /**
   * A alíquota informada na requisição vence a publicada: é o que permite
   * simular cenário contra a norma vigente, que é o uso do simulador.
   */
  it('alíquota informada vence a publicada, e volta a ser premissa', async () => {
    const service = new SimulationService(
      poolDeFila(
        [MEDICAO],
        [
          { tax: 'ibs_uf', value: '10.5', source: 'x' },
          { tax: 'ibs_mun', value: '2.5', source: 'x' },
          { tax: 'cbs', value: '9.0', source: 'x' },
        ],
        [GRAVACAO],
      ),
    );

    const r = await service.run(SCOPE, { ...pedido, overrides: { ibs_cbs_rate: 30 } }, null);

    expect(premissa(r, 'ibs_cbs_rate').origin).toBe('provided');
  });
});

describe('serviço de simulação — medição da base', () => {
  it('divide receita e compras pelos meses com movimento', async () => {
    const service = new SimulationService(poolDeFila([MEDICAO], [], [GRAVACAO]));

    const r = await service.run(SCOPE, pedido, null);

    expect(r.result.base.monthlyRevenueCents).toBe(1_000_000);
    expect(r.result.base.monthlyInputsCents).toBe(333_333);
    expect(r.result.base.monthsConsidered).toBe(12);
  });

  it('a fração contra PJ é a razão entre saída para PJ e saída total', async () => {
    const service = new SimulationService(poolDeFila([MEDICAO], [], [GRAVACAO]));

    const r = await service.run(SCOPE, pedido, null);

    expect(r.result.base.b2bShare).toBeCloseTo(0.5, 5);
  });

  /** Sem receita de saída, a fração é zero e não uma divisão por zero. */
  it('sem receita de saída, a fração contra PJ é zero e não NaN', async () => {
    const service = new SimulationService(
      poolDeFila(
        [{ ...MEDICAO, saida: '0', saida_pj: '0' }],
        [],
        [GRAVACAO],
      ),
    );

    const r = await service.run(SCOPE, pedido, null);

    expect(r.result.base.b2bShare).toBe(0);
    expect(Number.isNaN(r.result.base.b2bShare)).toBe(false);
  });

  /** Zero mês com movimento não pode virar divisão por zero. */
  it('zero meses conta como um, em vez de dividir por zero', async () => {
    const service = new SimulationService(
      poolDeFila([{ ...MEDICAO, meses: '0' }], [], [GRAVACAO]),
    );

    const r = await service.run(SCOPE, pedido, null);

    expect(r.result.base.monthsConsidered).toBe(1);
    expect(r.result.base.monthlyRevenueCents).toBe(12_000_000);
  });

  it('sem documento, recusa em vez de projetar sobre nada', async () => {
    const service = new SimulationService(
      poolDeFila([{ ...MEDICAO, documentos: '0' }], [], [GRAVACAO]),
    );

    await expect(service.run(SCOPE, pedido, null)).rejects.toThrow(
      /qualquer número seria inventado/,
    );
  });
});
