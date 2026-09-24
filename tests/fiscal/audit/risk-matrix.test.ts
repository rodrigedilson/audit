import { describe, expect, it } from 'vitest';

import {
  assess,
  impactFromShare,
  likelihoodFromFrequency,
  scoreToSeverity,
} from '../../../src/fiscal/audit/risk-matrix.js';

describe('scoreToSeverity — as faixas nos limites', () => {
  it.each([
    [1, 'low'],
    [4, 'low'],
    [5, 'medium'],
    [9, 'medium'],
    [10, 'high'],
    [15, 'high'],
    [16, 'critical'],
    [25, 'critical'],
  ])('score %i é %s', (score, esperado) => {
    expect(scoreToSeverity(score)).toBe(esperado);
  });
});

describe('likelihoodFromFrequency', () => {
  /**
   * Nada examinado é probabilidade mínima, não média. Devolver 3 colocaria no
   * meio da escala um risco sobre o qual não há observação nenhuma.
   */
  it('população vazia é probabilidade mínima, não 3', () => {
    expect(likelihoodFromFrequency(0, 0)).toBe(1);
  });

  it('nenhuma falha é probabilidade mínima', () => {
    expect(likelihoodFromFrequency(0, 5000)).toBe(1);
  });

  it('falha em tudo é probabilidade máxima', () => {
    expect(likelihoodFromFrequency(5000, 5000)).toBe(5);
  });

  it('sobe com a frequência observada', () => {
    expect(likelihoodFromFrequency(1, 1000)).toBe(1);
    expect(likelihoodFromFrequency(3, 100)).toBe(2);
    expect(likelihoodFromFrequency(10, 100)).toBe(3);
    expect(likelihoodFromFrequency(40, 100)).toBe(4);
    expect(likelihoodFromFrequency(80, 100)).toBe(5);
  });

  it('nunca baixa quando aparecem mais falhas na mesma população', () => {
    let anterior = likelihoodFromFrequency(0, 200);
    for (const falhas of [1, 5, 20, 60, 120, 200]) {
      const atual = likelihoodFromFrequency(falhas, 200);
      expect(atual, `falhas=${falhas}`).toBeGreaterThanOrEqual(anterior);
      anterior = atual;
    }
  });
});

describe('impactFromShare', () => {
  it('sem valor em risco o impacto é mínimo', () => {
    expect(impactFromShare(0, 1_000_000)).toBe(1);
  });

  /**
   * Qualquer valor é 100% de uma competência que não deve nada — e uma
   * competência sem débito com crédito indevido apropriado é justamente o caso
   * que não pode sair como impacto baixo.
   */
  it('base zero com valor em risco é impacto máximo', () => {
    expect(impactFromShare(1, 0)).toBe(5);
  });

  it('sobe com a fração do débito da competência', () => {
    const base = 1_000_000;
    expect(impactFromShare(3_000, base)).toBe(1);
    expect(impactFromShare(15_000, base)).toBe(2);
    expect(impactFromShare(40_000, base)).toBe(3);
    expect(impactFromShare(90_000, base)).toBe(4);
    expect(impactFromShare(500_000, base)).toBe(5);
  });

  /**
   * O motivo de o impacto ser adimensional: o mesmo valor absoluto é ruído num
   * contribuinte e é grave no outro.
   */
  it('o mesmo valor pesa diferente conforme o porte da competência', () => {
    expect(impactFromShare(50_000, 100_000)).toBe(5);
    expect(impactFromShare(50_000, 50_000_000)).toBe(1);
  });
});

describe('assess', () => {
  it('compõe score, severidade e preserva o denominador da observação', () => {
    const risco = assess({
      failures: 40,
      examined: 100,
      amountAtStakeCents: 90_000,
      periodBaseCents: 1_000_000,
    });

    expect(risco.likelihood).toBe(4);
    expect(risco.impact).toBe(4);
    expect(risco.score).toBe(16);
    expect(risco.severity).toBe('critical');
    expect(risco.observed).toEqual({ failures: 40, examined: 100 });
    expect(risco.periodBaseCents).toBe(1_000_000);
  });

  /**
   * "5 de 5" e "5000 de 5000" dão a mesma probabilidade e não significam a
   * mesma coisa para quem lê o Book. Sem o denominador, o número não tem
   * defesa.
   */
  it('mesma probabilidade com populações diferentes continua distinguível', () => {
    const pequena = assess({
      failures: 5,
      examined: 5,
      amountAtStakeCents: 1_000,
      periodBaseCents: 1_000_000,
    });
    const grande = assess({
      failures: 5_000,
      examined: 5_000,
      amountAtStakeCents: 1_000,
      periodBaseCents: 1_000_000,
    });

    expect(pequena.likelihood).toBe(grande.likelihood);
    expect(pequena.observed.examined).not.toBe(grande.observed.examined);
  });

  it('o score é sempre inteiro entre 1 e 25', () => {
    for (const falhas of [0, 1, 7, 99, 100]) {
      for (const valor of [0, 1, 50_000, 10_000_000]) {
        const risco = assess({
          failures: falhas,
          examined: 100,
          amountAtStakeCents: valor,
          periodBaseCents: 1_000_000,
        });

        expect(Number.isInteger(risco.score)).toBe(true);
        expect(risco.score).toBeGreaterThanOrEqual(1);
        expect(risco.score).toBeLessThanOrEqual(25);
      }
    }
  });
});
