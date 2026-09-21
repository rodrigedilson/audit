import { describe, it, expect } from 'vitest';
import {
  PeriodTransitionService,
  ClosedPeriodGuardService,
} from '../../../src/fiscal/period/period-transition.service.js';
import {
  VALID_PERIOD_TRANSITIONS,
  PERIOD_STATES,
  type FiscalAction,
  type PeriodState,
} from '../../../src/fiscal/shared/fiscal-vocabulary.js';
import {
  InvalidTransitionError,
  ClosedPeriodViolationError,
} from '../../../src/esaa/shared/types/esaa-errors.js';
import type { FiscalProjection } from '../../../src/fiscal/shared/fiscal-projection.types.js';

const PERIODO = '2027-10';

function projecao(state: PeriodState): FiscalProjection {
  return {
    cnpj: '12345678000195',
    periods: { [PERIODO]: { state } },
  } as unknown as FiscalProjection;
}

describe('máquina de estados da competência', () => {
  const service = new PeriodTransitionService();

  describe('avanço normal do fechamento', () => {
    it('open vai para assessed pela apuração', () => {
      expect(service.resolve('assessment.projected', 'open', PERIODO)).toBe('assessed');
    });

    it('assessed vai para reconciled pela contra-apuração', () => {
      expect(service.resolve('assessment.compared', 'assessed', PERIODO)).toBe('reconciled');
    });

    it('reconciled vai para confirmed pela confirmação', () => {
      expect(service.resolve('assessment.confirmed', 'reconciled', PERIODO)).toBe('confirmed');
    });
  });

  describe('autotransições', () => {
    /**
     * Reapurar depois de ingerir mais documentos é operação normal do
     * fechamento. Sem a autotransição, o contador teria de conciliar uma
     * apuração que ele sabe estar incompleta só para poder corrigi-la.
     */
    it('assessed aceita reapuração e ajuste', () => {
      expect(service.resolve('assessment.projected', 'assessed', PERIODO)).toBe('assessed');
      expect(service.resolve('assessment.adjusted', 'assessed', PERIODO)).toBe('assessed');
    });

    /**
     * O Fisco pode enviar proposta corrigida, e o upload pode ser refeito depois
     * de arrumar um erro de layout. Sem a autotransição, recomparar exigiria
     * voltar a `assessed` — registrando no log uma reapuração que não aconteceu.
     */
    it('reconciled aceita nova comparação, sem passar por assessed', () => {
      expect(service.resolve('assessment.compared', 'reconciled', PERIODO)).toBe('reconciled');
    });

    it('ajuste em reconciled reabre a conciliação', () => {
      expect(service.resolve('assessment.adjusted', 'reconciled', PERIODO)).toBe('assessed');
    });
  });

  describe('INV-001 — confirmed é terminal', () => {
    it('nenhum estado sai de confirmed', () => {
      expect(VALID_PERIOD_TRANSITIONS.confirmed).toEqual([]);
    });

    it.each(['assessment.projected', 'assessment.compared', 'assessment.adjusted'] as const)(
      '%s é recusada em competência confirmada',
      (action) => {
        expect(() => service.resolve(action, 'confirmed', PERIODO)).toThrow(
          InvalidTransitionError,
        );
      },
    );

    /** Reconfirmar não é inofensivo: seria um segundo hash de fechamento. */
    it('confirmar de novo é recusado', () => {
      expect(() => service.resolve('assessment.confirmed', 'confirmed', PERIODO)).toThrow(
        InvalidTransitionError,
      );
    });
  });

  describe('salto de etapa', () => {
    it('open não vai direto a confirmed', () => {
      expect(() => service.resolve('assessment.confirmed', 'open', PERIODO)).toThrow(
        InvalidTransitionError,
      );
    });

    /**
     * Confirmar sem conciliar assinaria um número que nunca foi comparado com
     * nada — é exatamente o que o produto existe para impedir.
     */
    it('assessed não vai direto a confirmed', () => {
      expect(() => service.resolve('assessment.confirmed', 'assessed', PERIODO)).toThrow(
        InvalidTransitionError,
      );
    });

    it('open não vai direto a reconciled', () => {
      expect(() => service.resolve('assessment.compared', 'open', PERIODO)).toThrow(
        InvalidTransitionError,
      );
    });
  });

  describe('ações que não movem a competência', () => {
    it.each(['doc.received', 'item.classified', 'book.generated', 'certificate.stored'] as const)(
      '%s devolve o estado atual',
      (action) => {
        expect(service.resolve(action as FiscalAction, 'assessed', PERIODO)).toBe('assessed');
      },
    );

    /**
     * Gerar o Book de uma competência confirmada é o caso de uso previsto: a
     * ação não move o estado e por isso não colide com INV-001.
     */
    it('book.generated não é recusado em competência confirmada', () => {
      expect(service.resolve('book.generated', 'confirmed', PERIODO)).toBe('confirmed');
    });
  });

  it('transitionsFrom devolve exatamente a tabela declarada', () => {
    for (const estado of PERIOD_STATES) {
      expect(service.transitionsFrom(estado)).toEqual(VALID_PERIOD_TRANSITIONS[estado]);
    }
  });
});

describe('guarda de competência fechada (camada 6)', () => {
  const guard = new ClosedPeriodGuardService();

  it.each([
    'doc.received',
    'item.classified',
    'item.reclassified',
    'assessment.projected',
    'assessment.adjusted',
    'assessment.compared',
    'credit.recognized',
  ] as const)('%s é barrada em competência confirmada', (action) => {
    expect(() => guard.guard(projecao('confirmed'), action as FiscalAction, PERIODO)).toThrow(
      ClosedPeriodViolationError,
    );
  });

  /**
   * Leitura e geração de documento não mutam a competência. Barrá-las tornaria
   * a competência fechada inútil — ninguém poderia mais emitir o Book do mês
   * que acabou de fechar.
   */
  it.each(['book.generated', 'certificate.used', 'rectification.filed'] as const)(
    '%s passa mesmo com a competência confirmada',
    (action) => {
      expect(() =>
        guard.guard(projecao('confirmed'), action as FiscalAction, PERIODO),
      ).not.toThrow();
    },
  );

  it('não barra nada quando a ação não pertence a competência nenhuma', () => {
    expect(() => guard.guard(projecao('confirmed'), 'doc.received', undefined)).not.toThrow();
  });

  it('competência não confirmada aceita mutação', () => {
    for (const estado of ['open', 'assessed', 'reconciled'] as const) {
      expect(() => guard.guard(projecao(estado), 'doc.received', PERIODO)).not.toThrow();
    }
  });

  /** Competência que nunca foi aberta não é uma competência fechada. */
  it('competência desconhecida não é tratada como confirmada', () => {
    expect(() => guard.guard(projecao('confirmed'), 'doc.received', '2099-01')).not.toThrow();
  });

  it('isConfirmed reflete o estado da projeção', () => {
    expect(guard.isConfirmed(projecao('confirmed'), PERIODO)).toBe(true);
    expect(guard.isConfirmed(projecao('assessed'), PERIODO)).toBe(false);
    expect(guard.isConfirmed(projecao('confirmed'), '2099-01')).toBe(false);
  });
});
