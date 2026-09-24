import { describe, expect, it } from 'vitest';

import {
  canApply,
  propose,
  type AuditFinding,
  type ImpactSide,
  type FindingStatus,
} from '../../../src/fiscal/audit/findings.js';
import { assess } from '../../../src/fiscal/audit/risk-matrix.js';
import { VERIFICATIONS, type VerificationResult } from '../../../src/fiscal/audit/verifications.js';
import type { PeriodState } from '../../../src/fiscal/shared/fiscal-vocabulary.js';

const verificacoes = (falha: number): VerificationResult[] =>
  VERIFICATIONS.map((v, i) => ({
    verification: v,
    outcome: i === falha ? ('fail' as const) : ('pass' as const),
    rationale: 'motivo',
    compared: [],
  }));

const achado = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  findingId: 'doc-cancelado:2027-01:352701…',
  procedureId: 'doc-cancelado',
  period: '2027-01',
  subject: '352701…',
  verifications: verificacoes(3),
  failed: ['v4_autorizacao_competente'],
  impactCents: 120_000,
  impactSide: 'credito_a_estornar',
  risk: assess({
    failures: 1,
    examined: 100,
    amountAtStakeCents: 120_000,
    periodBaseCents: 1_000_000,
  }),
  criterion: {
    criterion_id: 'lc-214-156a',
    kind: 'lei_complementar',
    citation: 'LC 214/2025, art. 156-A',
    verified: true,
  },
  assertable: true,
  status: 'accepted',
  ...over,
});

const propor = (
  over: Partial<AuditFinding> = {},
  periodState: PeriodState = 'assessed',
  alreadyReversed = false,
) => propose({ finding: achado(over), periodState, alreadyReversed });

describe('propose — o estorno que o teste de comprovação autoriza', () => {
  it('achado aceito, conferido e em competência aberta pode ser aplicado', () => {
    const p = propor();

    expect(p.blockers).toEqual([]);
    expect(canApply(p)).toBe(true);
    expect(p.creditReversedCents).toBe(120_000);
    expect(p.debitConstitutedCents).toBe(0);
    expect(p.netEffectCents).toBe(120_000);
  });

  it('fundamenta o estorno na primeira falha na ordem do teste', () => {
    const p = propor({
      verifications: verificacoes(1),
      failed: ['v2_data_documento_x_lancamento', 'v4_autorizacao_competente'],
    });

    expect(p.basis.verification).toBe('v2_data_documento_x_lancamento');
    expect(p.basis.criterion?.citation).toBe('LC 214/2025, art. 156-A');
  });

  /**
   * Os dois lados somam porque apontam na mesma direção: estornar crédito e
   * constituir débito aumentam o imposto devido. Compensá-los esconderia
   * metade do efeito.
   */
  it('débito constituído entra no efeito líquido, e não compensa o crédito', () => {
    const p = propor({ impactSide: 'debito_a_constituir' });

    expect(p.creditReversedCents).toBe(0);
    expect(p.debitConstitutedCents).toBe(120_000);
    expect(p.netEffectCents).toBe(120_000);
  });
});

describe('propose — o que impede o estorno', () => {
  it('critério não conferido impede: o achado existe e não afirma', () => {
    expect(propor({ assertable: false }).blockers).toContain('criterio_nao_conferido');
  });

  /**
   * Invalidar um lançamento com base num exame que não terminou seria afirmar
   * a distorção sem tê-la comprovado.
   */
  it('teste sem falha comprovada impede', () => {
    expect(propor({ failed: [] }).blockers).toContain('teste_inconclusivo');
  });

  it('competência confirmada impede — o caminho é a retificação (INV-001)', () => {
    expect(propor({}, 'confirmed').blockers).toContain('competencia_confirmada');
  });

  it.each<FindingStatus>(['open', 'rejected', 'resolved'])(
    'achado em %s impede: só o que o contador aceitou vira estorno',
    (status) => {
      expect(propor({ status }).blockers).toContain('achado_nao_aceito_pelo_contador');
    },
  );

  it('achado sem efeito no saldo impede', () => {
    expect(propor({ impactSide: 'sem_efeito_no_saldo' as ImpactSide }).blockers).toContain(
      'sem_efeito_no_saldo',
    );
  });

  it('estorno já aplicado impede o segundo', () => {
    expect(propor({}, 'assessed', true).blockers).toContain('estorno_ja_aplicado');
  });

  it('impedimentos se acumulam, para a tela listar tudo que falta de uma vez', () => {
    const p = propor({ assertable: false, status: 'open', failed: [] }, 'confirmed');

    expect(p.blockers).toEqual(
      expect.arrayContaining([
        'criterio_nao_conferido',
        'teste_inconclusivo',
        'competencia_confirmada',
        'achado_nao_aceito_pelo_contador',
      ]),
    );
    expect(canApply(p)).toBe(false);
  });

  /**
   * A proposta é calculada mesmo bloqueada: a tela precisa mostrar quanto
   * estaria em jogo para o contador decidir se vale destravar.
   */
  it('proposta bloqueada ainda traz os valores', () => {
    const p = propor({ status: 'open' });

    expect(canApply(p)).toBe(false);
    expect(p.netEffectCents).toBe(120_000);
  });
});
