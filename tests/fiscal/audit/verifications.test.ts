import { describe, expect, it } from 'vitest';

import {
  conclude,
  failedVerifications,
  isInconclusive,
  isReliable,
  VERIFICATIONS,
  VERIFICATION_LABELS,
  type Verification,
  type VerificationOutcome,
  type VerificationResult,
} from '../../../src/fiscal/audit/verifications.js';

const r = (
  verification: Verification,
  outcome: VerificationOutcome,
): VerificationResult => ({
  verification,
  outcome,
  rationale: `${verification}: ${outcome}`,
  compared: [],
});

/** As cinco com o mesmo veredito. */
const todas = (outcome: VerificationOutcome): VerificationResult[] =>
  VERIFICATIONS.map((v) => r(v, outcome));

describe('as cinco verificações', () => {
  it('a ordem é a do teste, e a primeira é pré-requisito das demais', () => {
    expect(VERIFICATIONS[0]).toBe('v1_fidedignidade_e_atores');
    expect(VERIFICATIONS).toHaveLength(5);
  });

  it('toda verificação tem rótulo que explica o que confere', () => {
    for (const v of VERIFICATIONS) {
      expect(VERIFICATION_LABELS[v].trim().length, v).toBeGreaterThan(20);
    }
  });
});

describe('isReliable — evidência de confiabilidade', () => {
  it('exige as cinco em pass', () => {
    expect(isReliable(todas('pass'))).toBe(true);
  });

  /**
   * O ponto do veredito de três valores. Quatro conferidas e uma ignorada não
   * é um lançamento conferido, e chamá-lo de confiável seria a afirmação mais
   * cara que este módulo pode fazer errada.
   */
  it('um not_verified no meio derruba a confiabilidade', () => {
    const results = todas('pass');
    results[3] = r('v4_autorizacao_competente', 'not_verified');

    expect(isReliable(results)).toBe(false);
  });

  it('conjunto incompleto não é confiável, mesmo que tudo que rodou tenha passado', () => {
    expect(isReliable([r('v1_fidedignidade_e_atores', 'pass')])).toBe(false);
  });
});

describe('failedVerifications', () => {
  it('preserva a ordem canônica, não a ordem de chegada', () => {
    const results = [
      r('v5_relacao_com_a_atividade', 'fail'),
      r('v2_data_documento_x_lancamento', 'fail'),
    ];

    expect(failedVerifications(results)).toEqual([
      'v2_data_documento_x_lancamento',
      'v5_relacao_com_a_atividade',
    ]);
  });

  it('não confunde not_verified com fail', () => {
    expect(failedVerifications(todas('not_verified'))).toEqual([]);
  });
});

describe('conclude', () => {
  it('cinco pass é confiável', () => {
    expect(conclude(todas('pass'))).toBe('confiavel');
  });

  it('alguma falha é distorção relevante', () => {
    const results = todas('pass');
    results[2] = r('v3_lancamento_correto', 'fail');

    expect(conclude(results)).toBe('distorcao_relevante');
  });

  it('sem falha e com não verificada é inconclusivo', () => {
    const results = todas('pass');
    results[4] = r('v5_relacao_com_a_atividade', 'not_verified');

    expect(conclude(results)).toBe('inconclusivo');
    expect(isInconclusive(results)).toBe(true);
  });

  /**
   * Falha é conclusão e prevalece sobre inconclusivo: um documento cancelado
   * com crédito apropriado é distorção provada, e esperar pela verificação 5
   * adiaria um achado que se sustenta sozinho.
   */
  it('falha prevalece sobre não verificada', () => {
    const results = todas('pass');
    results[3] = r('v4_autorizacao_competente', 'fail');
    results[4] = r('v5_relacao_com_a_atividade', 'not_verified');

    expect(conclude(results)).toBe('distorcao_relevante');
  });
});
