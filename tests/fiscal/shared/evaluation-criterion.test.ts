import { describe, expect, it } from 'vitest';

import {
  canAssert,
  isEffective,
  isInternal,
  toRef,
  type EvaluationCriterion,
} from '../../../src/fiscal/shared/evaluation-criterion.js';
import {
  CRITERIOS_INTERNOS,
  criterioInterno,
} from '../../../src/fiscal/shared/criterios-internos.js';

const normativo = (over: Partial<EvaluationCriterion> = {}): EvaluationCriterion => ({
  criterionId: 'lc-214-156a',
  kind: 'lei_complementar',
  citation: 'LC 214/2025, art. 156-A',
  parameter: 'O crédito de IBS exige extinção do tributo da etapa anterior.',
  validFrom: '2026-01-01',
  validTo: null,
  sourceRef: 'https://www.planalto.gov.br/…',
  verified: true,
  ...over,
});

describe('EvaluationCriterion — vigência', () => {
  it('critério normativo não vale antes da vigência', () => {
    expect(isEffective(normativo(), '2025-12-31')).toBe(false);
    expect(isEffective(normativo(), '2026-01-01')).toBe(true);
  });

  it('critério revogado deixa de valer no dia seguinte ao fim', () => {
    const revogado = normativo({ validTo: '2026-06-30' });

    expect(isEffective(revogado, '2026-06-30')).toBe(true);
    expect(isEffective(revogado, '2026-07-01')).toBe(false);
  });

  /**
   * Uma invariante do produto não tem data de início: ela vale enquanto o
   * código que a implementa vale. Dar-lhe vigência obrigaria a inventar uma
   * data, e a data inventada acabaria impressa num Book.
   */
  it('critério interno é sempre vigente, em qualquer data', () => {
    const inv = criterioInterno('competencia-confirmada-e-terminal');

    expect(isInternal(inv.kind)).toBe(true);
    expect(inv.validFrom).toBeNull();
    expect(isEffective(inv, '1999-01-01')).toBe(true);
    expect(isEffective(inv, '2099-12-31')).toBe(true);
  });
});

describe('EvaluationCriterion — o que pode sustentar afirmação', () => {
  it('critério conferido e vigente sustenta', () => {
    expect(canAssert(normativo(), '2026-03-01')).toBe(true);
  });

  /**
   * O ponto do módulo inteiro: citação digitada e não conferida em texto
   * oficial continua sendo exibida, e não afirma. Dizer "este crédito é
   * indevido conforme o art. X" sem que ninguém tenha aberto o art. X é
   * exatamente o erro que o produto usa como contraposicionamento.
   */
  it('critério não conferido não sustenta, mesmo vigente', () => {
    expect(canAssert(normativo({ verified: false, sourceRef: null }), '2026-03-01')).toBe(false);
  });

  it('critério conferido mas fora de vigência não sustenta', () => {
    expect(canAssert(normativo({ validTo: '2026-01-31' }), '2026-03-01')).toBe(false);
  });

  it('ausência de critério não sustenta', () => {
    expect(canAssert(null, '2026-03-01')).toBe(false);
  });
});

describe('CRITERIOS_INTERNOS', () => {
  const todos = Object.values(CRITERIOS_INTERNOS);

  it('todo critério interno é de espécie interna, e conferível neste repositório', () => {
    for (const c of todos) {
      expect(isInternal(c.kind), c.criterionId).toBe(true);
      expect(c.verified, c.criterionId).toBe(true);
      expect(c.sourceRef, c.criterionId).not.toBeNull();
    }
  });

  it('nenhum tem citação ou parâmetro vazio — critério mudo não explica nada', () => {
    for (const c of todos) {
      expect(c.citation.trim().length, c.criterionId).toBeGreaterThan(0);
      expect(c.parameter.trim().length, c.criterionId).toBeGreaterThan(0);
    }
  });

  it('a chave do catálogo é o próprio criterionId', () => {
    for (const [chave, c] of Object.entries(CRITERIOS_INTERNOS)) {
      expect(c.criterionId).toBe(chave);
    }
  });

  it('os identificadores são únicos', () => {
    const ids = todos.map((c) => c.criterionId);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('toRef', () => {
  /**
   * A forma reduzida existe para não repetir o `parameter` em cada um dos
   * milhares de `output.rejected` de um lote grande: o texto não muda, e
   * inflaria o log.
   */
  it('leva o que identifica e cita, e deixa o parâmetro no catálogo', () => {
    const ref = toRef(normativo());

    expect(ref).toEqual({
      criterion_id: 'lc-214-156a',
      kind: 'lei_complementar',
      citation: 'LC 214/2025, art. 156-A',
      verified: true,
    });
    expect(ref).not.toHaveProperty('parameter');
  });

  it('preserva `verified: false`, que é o que a tela precisa para ressalvar', () => {
    expect(toRef(normativo({ verified: false })).verified).toBe(false);
  });
});
