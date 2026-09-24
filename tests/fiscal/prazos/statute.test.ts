import { describe, expect, it } from 'vitest';

import {
  basisFor,
  computeStatute,
  initialTerm,
  REGRAS_CTN,
  type ClockEvent,
  type StatuteBasisMapping,
  type StatuteInput,
  type StatuteKind,
  type StatuteRule,
} from '../../../src/fiscal/prazos/statute.js';

const regra = (kind: StatuteKind, over: Partial<StatuteRule> = {}): StatuteRule => ({
  ...REGRAS_CTN.find((r) => r.kind === kind)!,
  active: true,
  ...over,
});

const mapeamento = (over: Partial<StatuteBasisMapping> = {}): StatuteBasisMapping => ({
  tax: 'ibs',
  regime: null,
  kind: 'decadencia_150_4',
  validFrom: '2026-01-01',
  validTo: null,
  legalBasis: 'CTN, art. 150, §4º',
  verified: true,
  ...over,
});

const ato = (
  effect: ClockEvent['effect'],
  occurredAt: string,
  kind: ClockEvent['kind'] = 'protesto_cda',
): ClockEvent => ({ kind, effect, occurredAt, legalBasis: 'LC 208/2021', eventSeq: 1 });

const entrada = (over: Partial<StatuteInput> = {}): StatuteInput => ({
  rule: regra('decadencia_150_4'),
  mapping: mapeamento(),
  period: '2027-03',
  definitiveConstitutionAt: null,
  clockEvents: [],
  today: '2028-01-01',
  ...over,
});

describe('termo inicial por modalidade de lançamento', () => {
  /**
   * A diferença entre os dois artigos é um ano inteiro de prazo, e é por isso
   * que o produto precisa nomear qual está correndo.
   */
  it('art. 173, I conta do 1º de janeiro do exercício seguinte', () => {
    expect(initialTerm('primeiro_dia_exercicio_seguinte', entrada())).toBe('2028-01-01');
  });

  it('art. 150, §4º conta do fato gerador — o último dia da competência', () => {
    expect(initialTerm('fato_gerador', entrada())).toBe('2027-03-31');
  });

  it('o último dia respeita fevereiro', () => {
    expect(initialTerm('fato_gerador', entrada({ period: '2027-02' }))).toBe('2027-02-28');
  });

  it('a prescrição conta da constituição definitiva, e sem ela não há termo', () => {
    expect(initialTerm('constituicao_definitiva', entrada())).toBeNull();
    expect(
      initialTerm('constituicao_definitiva', entrada({ definitiveConstitutionAt: '2027-06-10' })),
    ).toBe('2027-06-10');
  });
});

describe('computeStatute — decadência', () => {
  it('vence cinco anos depois do fato gerador', () => {
    const s = computeStatute(entrada());

    expect(s.startsAt).toBe('2027-03-31');
    expect(s.expiresAt).toBe('2032-03-31');
    expect(s.expired).toBe(false);
    expect(s.legalBasis).toBe('CTN, art. 150, §4º');
  });

  it('reconhece o crédito já extinto', () => {
    const s = computeStatute(entrada({ today: '2032-04-01' }));

    expect(s.expired).toBe(true);
    expect(s.daysLeft).toBeLessThan(0);
  });

  /**
   * Decadência não se interrompe nem se suspende. Aplicar os atos a ela daria
   * ao Fisco prazo que a lei não dá.
   */
  it('não se interrompe: o ato não move o vencimento', () => {
    const s = computeStatute(
      entrada({ clockEvents: [ato('interrupt', '2030-01-01'), ato('suspend', '2030-06-01')] }),
    );

    expect(s.startsAt).toBe('2027-03-31');
    expect(s.expiresAt).toBe('2032-03-31');
    expect(s.suspendedDays).toBe(0);
  });
});

describe('computeStatute — prescrição', () => {
  const prescricao = (over: Partial<StatuteInput> = {}): StatuteInput =>
    entrada({
      rule: regra('prescricao_174'),
      mapping: mapeamento({ kind: 'prescricao_174' }),
      definitiveConstitutionAt: '2027-06-10',
      today: '2029-01-01',
      ...over,
    });

  it('vence cinco anos depois da constituição definitiva', () => {
    expect(computeStatute(prescricao()).expiresAt).toBe('2032-06-10');
  });

  /** O protesto de CDA interrompe a prescrição tributária desde a LC 208/2021. */
  it('a interrupção zera e reinicia o prazo', () => {
    const s = computeStatute(prescricao({ clockEvents: [ato('interrupt', '2028-02-20')] }));

    expect(s.startsAt).toBe('2028-02-20');
    expect(s.expiresAt).toBe('2033-02-20');
  });

  /**
   * A distinção que mais custa: parcelamento SUSPENDE. Tratá-lo como
   * interrupção daria ao Fisco cinco anos novos onde a lei dá só a retomada do
   * que sobrava — e o alerta sairia anos errado, contra o contribuinte.
   */
  it('a suspensão soma o período parado, e não reinicia', () => {
    const s = computeStatute(
      prescricao({
        clockEvents: [
          ato('suspend', '2028-01-01', 'parcelamento_deferido'),
          ato('resume', '2028-07-01', 'parcelamento_rescindido'),
        ],
        today: '2029-01-01',
      }),
    );

    expect(s.startsAt).toBe('2027-06-10');
    expect(s.suspendedDays).toBe(182);
    expect(s.expiresAt).toBe('2032-12-09');
  });

  it('suspensão ainda aberta conta até hoje: o prazo está parado agora', () => {
    const s = computeStatute(
      prescricao({
        clockEvents: [ato('suspend', '2028-01-01', 'decisao_judicial_suspensiva')],
        today: '2028-03-01',
      }),
    );

    expect(s.suspendedDays).toBe(60);
  });

  it('interromper depois de suspender descarta a suspensão — o prazo recomeçou', () => {
    const s = computeStatute(
      prescricao({
        clockEvents: [
          ato('suspend', '2028-01-01', 'parcelamento_deferido'),
          ato('interrupt', '2028-06-01', 'citacao_em_execucao_fiscal'),
        ],
        today: '2029-01-01',
      }),
    );

    expect(s.startsAt).toBe('2028-06-01');
    expect(s.suspendedDays).toBe(0);
    expect(s.expiresAt).toBe('2033-06-01');
  });

  it('os atos são aplicados em ordem cronológica, não na ordem de chegada', () => {
    const fora = computeStatute(
      prescricao({
        clockEvents: [ato('interrupt', '2028-06-01'), ato('interrupt', '2028-02-01')],
      }),
    );

    expect(fora.startsAt).toBe('2028-06-01');
  });
});

describe('computeStatute — o que não é calculável', () => {
  /**
   * "Não consegui calcular" saindo como "não venceu" é a forma mais cara de
   * errar aqui: o escritório deixaria de impugnar um crédito já extinto.
   */
  it('regra ausente devolve expired null, nunca false', () => {
    const s = computeStatute(entrada({ rule: null }));

    expect(s.expiresAt).toBeNull();
    expect(s.expired).toBeNull();
    expect(s.unavailableReason).toContain('não está carregada');
  });

  it('regra desligada não afirma prazo', () => {
    const s = computeStatute(entrada({ rule: regra('decadencia_150_4', { active: false }) }));

    expect(s.expired).toBeNull();
    expect(s.unavailableReason).toContain('desligada');
  });

  it('sem mapeamento conferido não há termo inicial a afirmar', () => {
    const s = computeStatute(entrada({ mapping: null }));

    expect(s.expired).toBeNull();
    expect(s.unavailableReason).toContain('mapeamento');
  });

  it('mapeamento não conferido conta como ausente', () => {
    const s = computeStatute(entrada({ mapping: mapeamento({ verified: false }) }));

    expect(s.expired).toBeNull();
  });

  it('prescrição sem constituição definitiva não é calculável', () => {
    const s = computeStatute(
      entrada({
        rule: regra('prescricao_174'),
        mapping: mapeamento({ kind: 'prescricao_174' }),
        definitiveConstitutionAt: null,
      }),
    );

    expect(s.expiresAt).toBeNull();
    expect(s.unavailableReason).toContain('constituição definitiva');
  });
});

describe('basisFor', () => {
  const mapeamentos: StatuteBasisMapping[] = [
    mapeamento({ tax: 'ibs', regime: null }),
    mapeamento({ tax: 'ibs', regime: 'lucro_real', kind: 'decadencia_173_i' }),
    mapeamento({ tax: 'cbs', validFrom: '2028-01-01' }),
  ];

  it('o mapeamento específico do regime vence o genérico', () => {
    expect(basisFor(mapeamentos, 'ibs', 'lucro_real', '2027-06-01')?.kind).toBe('decadencia_173_i');
  });

  it('cai no genérico quando não há específico', () => {
    expect(basisFor(mapeamentos, 'ibs', 'simples_hibrido', '2027-06-01')?.kind).toBe(
      'decadencia_150_4',
    );
  });

  it('respeita a vigência', () => {
    expect(basisFor(mapeamentos, 'cbs', 'lucro_real', '2027-06-01')).toBeNull();
    expect(basisFor(mapeamentos, 'cbs', 'lucro_real', '2028-06-01')).not.toBeNull();
  });

  it('tributo sem mapeamento devolve nulo, e não um palpite', () => {
    expect(basisFor(mapeamentos, 'iss', 'lucro_real', '2027-06-01')).toBeNull();
  });
});

describe('REGRAS_CTN', () => {
  /**
   * O texto do artigo é conferível; a APLICAÇÃO a cada tributo não é. Por isso
   * as regras nascem conferidas e desligadas, e o mapeamento por tributo nasce
   * vazio.
   */
  it('nascem conferidas no texto e desligadas', () => {
    for (const r of REGRAS_CTN) {
      expect(r.verified, r.kind).toBe(true);
      expect(r.active, r.kind).toBe(false);
      expect(r.years, r.kind).toBe(5);
      expect(r.legalBasis, r.kind).toMatch(/^CTN, art\./);
    }
  });

  it('só a prescrição se interrompe', () => {
    for (const r of REGRAS_CTN) {
      expect(r.interruptible, r.kind).toBe(r.kind === 'prescricao_174');
    }
  });
});
