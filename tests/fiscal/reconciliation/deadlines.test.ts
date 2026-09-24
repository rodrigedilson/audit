import { describe, it, expect } from 'vitest';
import {
  derivePendencies,
  deriveDeadlines,
  LIMIARES_DE_GRAVIDADE,
  type DeadlineRule,
  type PeriodSnapshot,
} from '../../../src/fiscal/reconciliation/deadlines.js';

const CNPJ = '12345678000195';

function periodo(override: Partial<PeriodSnapshot> = {}): PeriodSnapshot {
  return {
    cnpj: CNPJ,
    period: '2027-09',
    state: 'open',
    regime: 'lucro_real',
    openedAt: '2027-09-01T00:00:00.000Z',
    ...override,
  };
}

const em = (iso: string) => new Date(iso);

const tipos = (lista: readonly { kind: string }[]): string[] => lista.map((p) => p.kind);

describe('calendário — pendências derivadas do estado', () => {
  /**
   * Competência do mês corrente não é pendência: documento ainda está chegando,
   * e alertar aqui treinaria o escritório a ignorar o alerta.
   */
  it('competência em curso não gera pendência', () => {
    const r = derivePendencies({
      periods: [periodo({ state: 'open' })],
      today: em('2027-09-20T12:00:00Z'),
    });

    expect(r).toHaveLength(0);
  });

  it('competência encerrada e aberta aparece como não apurada', () => {
    const r = derivePendencies({
      periods: [periodo({ state: 'open' })],
      today: em('2027-10-10T12:00:00Z'),
    });

    expect(tipos(r)).toEqual(['competencia_nao_apurada']);
    expect(r[0]!.daysOpen).toBe(9);
  });

  it('apurada e não confirmada aparece com o estado no texto', () => {
    const r = derivePendencies({
      periods: [periodo({ state: 'assessed' })],
      today: em('2027-10-10T12:00:00Z'),
    });

    expect(tipos(r)).toEqual(['apuracao_nao_confirmada']);
    expect(r[0]!.message).toContain('apurada');
  });

  it('conciliada e não confirmada também é pendência, com o texto próprio', () => {
    const r = derivePendencies({
      periods: [periodo({ state: 'reconciled' })],
      today: em('2027-10-10T12:00:00Z'),
    });

    expect(r[0]!.message).toContain('conciliada');
  });

  it('competência confirmada não gera pendência de estado', () => {
    const r = derivePendencies({
      periods: [periodo({ state: 'confirmed' })],
      today: em('2028-06-01T12:00:00Z'),
    });

    expect(r).toHaveLength(0);
  });

  describe('gravidade pela idade', () => {
    const idade = (dias: number) => {
      const base = new Date(Date.UTC(2027, 9, 1, 0, 0, 0)); // 2027-10-01
      base.setUTCDate(base.getUTCDate() + dias);
      return derivePendencies({ periods: [periodo({ state: 'open' })], today: base })[0]!;
    };

    it('sobe de baixa a crítica conforme a pendência envelhece', () => {
      expect(idade(1).severity).toBe('low');
      expect(idade(LIMIARES_DE_GRAVIDADE.medium).severity).toBe('medium');
      expect(idade(LIMIARES_DE_GRAVIDADE.high).severity).toBe('high');
      expect(idade(LIMIARES_DE_GRAVIDADE.critical).severity).toBe('critical');
    });
  });

  describe('proposta do Fisco', () => {
    const comFisco = (override: Partial<NonNullable<PeriodSnapshot['fisco']>> = {}) =>
      periodo({
        state: 'assessed',
        fisco: {
          uploadedAt: '2027-10-05T12:00:00.000Z',
          lineLevel: true,
          criticalDivergences: 0,
          highDivergences: 0,
          ...override,
        },
      });

    /**
     * O achado central do diferencial #5: divergência grave em pé e competência
     * não fechada depois disso. Na apuração assistida o silêncio é concordância.
     */
    it('divergência grave sem fechamento é sempre crítica', () => {
      const r = derivePendencies({
        periods: [comFisco({ criticalDivergences: 3, highDivergences: 1 })],
        today: em('2027-10-06T12:00:00Z'),
      });

      const sem = r.find((p) => p.kind === 'proposta_do_fisco_sem_resposta');
      expect(sem?.severity).toBe('critical');
      expect(sem?.message).toContain('silêncio do contribuinte');
    });

    /**
     * A gravidade não cai nos primeiros dias: a consequência de não responder
     * não depende de há quantos dias a proposta chegou, e rebaixá-la faria o
     * alerta aparecer tarde.
     */
    it('a gravidade não depende de há quantos dias a proposta chegou', () => {
      const um = derivePendencies({
        periods: [comFisco({ criticalDivergences: 1 })],
        today: em('2027-10-06T00:00:00Z'),
      });

      expect(um.find((p) => p.kind === 'proposta_do_fisco_sem_resposta')?.severity).toBe(
        'critical',
      );
    });

    /**
     * Fechar o mês depois de ver a proposta é decisão registrada, não omissão —
     * e o `confirmed` é justamente o registro dessa decisão.
     */
    it('competência fechada depois da proposta não é falta de resposta', () => {
      const r = derivePendencies({
        periods: [
          periodo({
            state: 'confirmed',
            fisco: {
              uploadedAt: '2027-10-05T12:00:00.000Z',
              lineLevel: true,
              criticalDivergences: 5,
              highDivergences: 2,
            },
          }),
        ],
        today: em('2027-11-01T12:00:00Z'),
      });

      expect(tipos(r)).not.toContain('proposta_do_fisco_sem_resposta');
    });

    it('proposta sem divergência grave não vira falta de resposta', () => {
      const r = derivePendencies({
        periods: [comFisco()],
        today: em('2027-10-20T12:00:00Z'),
      });

      expect(tipos(r)).not.toContain('proposta_do_fisco_sem_resposta');
    });

    /**
     * Sem detalhe, a comparação nota a nota não aconteceu. O calendário precisa
     * dizer isso: zero divergência de item aqui não é "confere".
     */
    it('proposta só de totais é avisada como não comparada nota a nota', () => {
      const r = derivePendencies({
        periods: [comFisco({ lineLevel: false })],
        today: em('2027-10-20T12:00:00Z'),
      });

      const aviso = r.find((p) => p.kind === 'proposta_do_fisco_sem_detalhe');
      expect(aviso?.message).toContain('não significa que as notas conferem');
    });

    it('ordena crítica antes das demais, e a mais antiga primeiro', () => {
      const r = derivePendencies({
        periods: [
          comFisco({ lineLevel: false }),
          {
            ...comFisco({ criticalDivergences: 1 }),
            cnpj: '98765432000199',
            period: '2027-08',
          },
        ],
        today: em('2027-11-10T12:00:00Z'),
      });

      expect(r[0]!.severity).toBe('critical');
    });
  });
});

describe('calendário — prazos normativos', () => {
  function regra(override: Partial<DeadlineRule> = {}): DeadlineRule {
    return {
      ruleId: 'teste',
      name: 'Prazo de teste',
      description: 'Descrição',
      appliesToRegimes: null,
      monthsAfter: 1,
      dayOfMonth: 20,
      dayRule: 'exact',
      fixedDate: null,
      warnDays: 10,
      severity: 'high',
      legalBasis: 'Norma fictícia usada só em teste',
      ...override,
    };
  }

  /**
   * `deadline_rules` nasce vazia de propósito: as datas citadas por terceiros no
   * briefing não foram conferidas em texto oficial. Lista vazia de prazo não é
   * "nada a vencer" — é "nada carregado", e a API diz isso à parte.
   */
  it('sem regra carregada, não inventa prazo nenhum', () => {
    expect(deriveDeadlines([], [periodo()])).toHaveLength(0);
  });

  it('deriva a data a partir da competência', () => {
    const r = deriveDeadlines([regra({ monthsAfter: 1, dayOfMonth: 20 })], [periodo()]);

    expect(r[0]!.dueDate).toBe('2027-10-20');
    expect(r[0]!.nature).toBe('normativo');
    expect(r[0]!.legalBasis).toContain('Norma fictícia');
  });

  /**
   * Dia 31 num mês de 30 escorregaria para o dia 1º do mês seguinte com
   * aritmética ingênua de data — e o prazo do mês passaria a vencer no outro.
   */
  it('dia 31 em mês de 30 cai no último dia, não no mês seguinte', () => {
    const r = deriveDeadlines(
      [regra({ monthsAfter: 1, dayOfMonth: 31 })],
      [periodo({ period: '2027-03' })],
    );

    expect(r[0]!.dueDate).toBe('2027-04-30');
  });

  it('fevereiro de ano bissexto respeita os 29 dias', () => {
    const r = deriveDeadlines(
      [regra({ monthsAfter: 1, dayOfMonth: 31 })],
      [periodo({ period: '2028-01' })],
    );

    expect(r[0]!.dueDate).toBe('2028-02-29');
  });

  it('a virada de ano não perde o prazo', () => {
    const r = deriveDeadlines(
      [regra({ monthsAfter: 2, dayOfMonth: 15 })],
      [periodo({ period: '2027-12' })],
    );

    expect(r[0]!.dueDate).toBe('2028-02-15');
  });

  it('data fixa vale para qualquer competência', () => {
    const r = deriveDeadlines(
      [regra({ fixedDate: '2027-03-31', monthsAfter: null, dayOfMonth: null })],
      [periodo({ period: '2027-01' }), periodo({ period: '2027-02' })],
    );

    expect(r.map((d) => d.dueDate)).toEqual(['2027-03-31', '2027-03-31']);
  });

  it('regra de outro regime não gera prazo para este CNPJ', () => {
    const r = deriveDeadlines(
      [regra({ appliesToRegimes: ['simples_hibrido'] })],
      [periodo({ regime: 'lucro_real' })],
    );

    expect(r).toHaveLength(0);
  });

  it('regra sem regime declarado vale para todos', () => {
    const r = deriveDeadlines([regra({ appliesToRegimes: null })], [periodo({ regime: 'mei' })]);

    expect(r).toHaveLength(1);
  });

  it('ordena por data de vencimento', () => {
    const r = deriveDeadlines(
      [regra({ ruleId: 'b', monthsAfter: 3 }), regra({ ruleId: 'a', monthsAfter: 1 })],
      [periodo()],
    );

    expect(r.map((d) => d.ruleId)).toEqual(['a', 'b']);
  });
});
/**
 * Dia útil.
 *
 * É a parte do calendário em que um erro fica invisível: a data sai plausível e
 * está errada. Os casos abaixo têm data conferível no calendário de 2027.
 */
describe('calendário — dia útil', () => {
  function regra(override: Partial<DeadlineRule> = {}): DeadlineRule {
    return {
      ruleId: 'teste',
      name: 'Prazo de teste',
      description: 'Descrição',
      appliesToRegimes: null,
      monthsAfter: 0,
      dayOfMonth: 10,
      dayRule: 'exact',
      fixedDate: null,
      warnDays: 10,
      severity: 'high',
      legalBasis: 'Norma fictícia usada só em teste',
      ...override,
    };
  }

  const dataDe = (r: DeadlineRule, period: string): string | undefined =>
    deriveDeadlines(
      [r],
      [
        {
          cnpj: '11222333000181',
          period,
          state: 'open',
          regime: 'lucro_real',
          openedAt: `${period}-01T00:00:00Z`,
        },
      ],
    )[0]?.dueDate;

  /**
   * Janeiro de 2027 começa numa sexta, e o dia 1º é feriado. Os dias úteis são
   * 4, 5, 6, 7, 8, 11, 12, 13, 14 e 15 — então o décimo é 15/01.
   */
  it('o décimo dia útil de janeiro de 2027 é dia 15', () => {
    expect(dataDe(regra({ dayRule: 'nth_business_day' }), '2027-01')).toBe('2027-01-15');
  });

  /** Sem a regra, o mesmo dia 10 cai num domingo — data que não existe como prazo. */
  it('o dia 10 de janeiro de 2027, exato, é um domingo', () => {
    expect(dataDe(regra(), '2027-01')).toBe('2027-01-10');
    expect(new Date('2027-01-10T00:00:00Z').getUTCDay()).toBe(0);
  });

  /**
   * O caso perigoso: 20 de junho de 2027 é um domingo. Antecipar leva a 18/06,
   * uma sexta. Sem antecipar, o calendário diria que há prazo até domingo — dois
   * dias depois do vencimento real.
   */
  it('dia 20 num domingo é antecipado para a sexta anterior', () => {
    expect(
      dataDe(regra({ dayOfMonth: 20, dayRule: 'anticipate_to_business_day' }), '2027-06'),
    ).toBe('2027-06-18');
  });

  /** Quando o dia já é útil, antecipar não move nada. */
  it('dia útil não é antecipado', () => {
    expect(
      dataDe(regra({ dayOfMonth: 20, dayRule: 'anticipate_to_business_day' }), '2027-07'),
    ).toBe('2027-07-20');
  });

  /**
   * Feriado móvel: a Páscoa de 2027 é em 28/03, então a Sexta-feira Santa é
   * 26/03 e o Carnaval é 09/02. Um prazo em 26/03 tem de recuar para 25/03.
   */
  it('recua em feriado móvel derivado da Páscoa', () => {
    expect(
      dataDe(regra({ dayOfMonth: 26, dayRule: 'anticipate_to_business_day' }), '2027-03'),
    ).toBe('2027-03-25');
  });

  it('recua no Carnaval, que a rede bancária não opera', () => {
    expect(
      dataDe(regra({ dayOfMonth: 9, dayRule: 'anticipate_to_business_day' }), '2027-02'),
    ).toBe('2027-02-08');
  });

  /** O prazo do mês X nunca vence no mês X+1, nem pedindo dia útil demais. */
  it('não escorrega para o mês seguinte', () => {
    const data = dataDe(regra({ dayOfMonth: 31, dayRule: 'nth_business_day' }), '2027-02');
    expect(data?.startsWith('2027-02')).toBe(true);
  });
});
