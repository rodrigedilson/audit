import { describe, it, expect } from 'vitest';
import { JsonParseValidator } from '../../../../src/esaa/core/validation/validators/json-parse.validator.js';
import { SchemaValidator } from '../../../../src/esaa/core/validation/validators/schema.validator.js';
import { VocabularyValidator } from '../../../../src/esaa/core/validation/validators/vocabulary.validator.js';
import { StateMachineValidator } from '../../../../src/esaa/core/validation/validators/state-machine.validator.js';
import { ImmutabilityValidator } from '../../../../src/esaa/core/validation/validators/immutability.validator.js';
import { VerificationGateValidator } from '../../../../src/esaa/core/validation/validators/verification-gate.validator.js';
import { FiscalProjectorService } from '../../../../src/fiscal/projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../../../../src/fiscal/projection/fiscal-hash-verifier.service.js';
import type { ESAAIntention } from '../../../../src/esaa/shared/types/esaa-event.types.js';
import type { FiscalProjection } from '../../../../src/fiscal/shared/fiscal-projection.types.js';
import { TEST_SCOPE, TEST_USER_ID, makeEvent, payloads } from '../../../helpers/scope.js';

const projector = new FiscalProjectorService();

/** Projeção derivada de eventos reais — não montada à mão, para o hash fechar. */
function projectionWith(...events: ReturnType<typeof makeEvent>[]): FiscalProjection {
  return projector.project(TEST_SCOPE.tenantId, TEST_SCOPE.cnpj, events);
}

const intention = (over: Partial<ESAAIntention> = {}): ESAAIntention => ({
  action: 'period.opened',
  task_id: '2027-01',
  actor: TEST_USER_ID,
  payload: { period: '2027-01' },
  ...over,
});

describe('Camada 1 — JsonParseValidator', () => {
  const validator = new JsonParseValidator();

  it('aceita intenção bem formada', () => {
    expect(() => validator.validate(intention())).not.toThrow();
  });

  it('rejeita campos obrigatórios ausentes', () => {
    expect(() => validator.validate({ action: 'period.opened' } as ESAAIntention)).toThrow();
  });
});

describe('Camada 2 — SchemaValidator', () => {
  const validator = new SchemaValidator();

  it('aceita intenção com tipos corretos', () => {
    expect(() => validator.validate(intention())).not.toThrow();
  });

  it('rejeita actor vazio', () => {
    expect(() => validator.validate(intention({ actor: '' }))).toThrow();
  });
});

describe('Camada 3 — VocabularyValidator', () => {
  const validator = new VocabularyValidator();

  it('aceita ação do vocabulário emitida por usuário', () => {
    expect(() => validator.validate(intention())).not.toThrow();
  });

  it('rejeita ação inexistente', () => {
    expect(() =>
      validator.validate(intention({ action: 'apuracao.magica' as ESAAIntention['action'] })),
    ).toThrow(/não existe no vocabulário/);
  });

  it('rejeita actor que não é usuário nem agente registrado', () => {
    expect(() => validator.validate(intention({ actor: 'estagiario' }))).toThrow(
      /não é um usuário nem um agente registrado/,
    );
  });

  /**
   * É o argumento de governança que se vende ao escritório: nenhuma IA altera um
   * número fiscal sozinha. Agente propõe; efetivar é do orquestrador.
   */
  it('rejeita agente tentando emitir ação que efetiva estado', () => {
    expect(() =>
      validator.validate(intention({ actor: 'classifier', action: 'item.classified' })),
    ).toThrow(/são do orquestrador/);
  });

  it('aceita agente emitindo proposta', () => {
    expect(() =>
      validator.validate(intention({ actor: 'classifier', action: 'item.classify' })),
    ).not.toThrow();
  });

  it('aceita o agente orquestrador emitindo ação efetivadora', () => {
    expect(() =>
      validator.validate(intention({ actor: 'closer', action: 'assessment.confirmed' })),
    ).not.toThrow();
  });

  it('rejeita usuário emitindo proposta de agente', () => {
    expect(() => validator.validate(intention({ action: 'item.classify' }))).toThrow(
      /proposta de agente/,
    );
  });
});

describe('Camada 4 — StateMachineValidator (ciclo da competência)', () => {
  const validator = new StateMachineValidator();

  const enrolled = makeEvent(
    0,
    'client.enrolled',
    TEST_SCOPE.cnpj,
    TEST_USER_ID,
    payloads.clientEnrolled(),
  );
  const opened = makeEvent(1, 'period.opened', '2027-01', TEST_USER_ID, payloads.periodOpened(), {
    period: '2027-01',
  });

  it('ignora intenção sem competência', () => {
    expect(() =>
      validator.validate(intention({ action: 'client.enrolled', period: undefined }), projectionWith()),
    ).not.toThrow();
  });

  it('rejeita competência fora do formato YYYY-MM', () => {
    expect(() => validator.validate(intention({ period: '2027/1' }), projectionWith())).toThrow(
      /fora do formato/,
    );
  });

  it('permite abrir competência inexistente', () => {
    expect(() =>
      validator.validate(intention({ period: '2027-01' }), projectionWith(enrolled)),
    ).not.toThrow();
  });

  it('rejeita reabrir competência já aberta', () => {
    expect(() =>
      validator.validate(intention({ period: '2027-01' }), projectionWith(enrolled, opened)),
    ).toThrow(/já está aberta/);
  });

  it('rejeita ação em competência que nunca foi aberta', () => {
    expect(() =>
      validator.validate(
        intention({ action: 'assessment.projected', period: '2027-05' }),
        projectionWith(enrolled, opened),
      ),
    ).toThrow(/não foi aberta/);
  });

  it('permite open → assessed', () => {
    expect(() =>
      validator.validate(
        intention({ action: 'assessment.projected', period: '2027-01' }),
        projectionWith(enrolled, opened),
      ),
    ).not.toThrow();
  });

  /**
   * Reapurar depois de ingerir mais documentos é operação normal do fechamento.
   * Sem a autotransição, o contador teria de conciliar uma apuração que ele sabe
   * estar incompleta só para poder corrigi-la.
   */
  it('permite reapurar uma competência já apurada', () => {
    const projecao = projectionWith(
      enrolled,
      opened,
      makeEvent(2, 'assessment.projected', '2027-01', TEST_USER_ID, {}, { period: '2027-01' }),
    );

    expect(projecao.periods['2027-01']?.state).toBe('assessed');
    expect(() =>
      validator.validate(
        intention({ action: 'assessment.projected', period: '2027-01' }),
        projecao,
      ),
    ).not.toThrow();
  });

  it('permite ajustar antes da conciliação', () => {
    const projecao = projectionWith(
      enrolled,
      opened,
      makeEvent(2, 'assessment.projected', '2027-01', TEST_USER_ID, {}, { period: '2027-01' }),
    );

    expect(() =>
      validator.validate(
        intention({ action: 'assessment.adjusted', period: '2027-01' }),
        projecao,
      ),
    ).not.toThrow();
  });

  it('permite voltar de reconciled para assessed por ajuste', () => {
    const projecao = projectionWith(
      enrolled,
      opened,
      makeEvent(2, 'assessment.projected', '2027-01', TEST_USER_ID, {}, { period: '2027-01' }),
      makeEvent(3, 'assessment.compared', '2027-01', TEST_USER_ID, {}, { period: '2027-01' }),
    );

    expect(projecao.periods['2027-01']?.state).toBe('reconciled');
    expect(() =>
      validator.validate(
        intention({ action: 'assessment.adjusted', period: '2027-01' }),
        projecao,
      ),
    ).not.toThrow();
  });

  /** `open → confirmed` salta a apuração e a conciliação: não existe. */
  it('rejeita salto de open direto para confirmed', () => {
    expect(() =>
      validator.validate(
        intention({ action: 'assessment.confirmed', period: '2027-01' }),
        projectionWith(enrolled, opened),
      ),
    ).toThrow(/Transição inválida/);
  });
});

describe('Camada 6 — ImmutabilityValidator (INV-001)', () => {
  const validator = new ImmutabilityValidator();

  const confirmedProjection = projectionWith(
    makeEvent(0, 'client.enrolled', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.clientEnrolled()),
    makeEvent(1, 'period.opened', '2027-01', TEST_USER_ID, payloads.periodOpened(), {
      period: '2027-01',
    }),
    makeEvent(2, 'assessment.projected', '2027-01', TEST_USER_ID, {}, { period: '2027-01' }),
    makeEvent(3, 'assessment.compared', '2027-01', TEST_USER_ID, {}, { period: '2027-01' }),
    makeEvent(
      4,
      'assessment.confirmed',
      '2027-01',
      TEST_USER_ID,
      { period: '2027-01', projection_hash: 'abc' },
      { period: '2027-01' },
    ),
  );

  it('a competência chega a confirmed pelo caminho legítimo', () => {
    expect(confirmedProjection.periods['2027-01']?.state).toBe('confirmed');
  });

  it('bloqueia ingestão de documento em competência confirmada', () => {
    expect(() =>
      validator.validate(
        intention({ action: 'doc.received', task_id: 'chave', period: '2027-01' }),
        confirmedProjection,
      ),
    ).toThrow(/confirmada e não pode ser alterada/);
  });

  it('bloqueia novo ajuste em competência confirmada', () => {
    expect(() =>
      validator.validate(
        intention({ action: 'assessment.adjusted', period: '2027-01' }),
        confirmedProjection,
      ),
    ).toThrow(/Use uma retificação/);
  });

  /** A retificação é a saída prevista: abre competência nova, não altera a antiga. */
  it('permite registrar retificação sobre competência confirmada', () => {
    expect(() =>
      validator.validate(
        intention({ action: 'rectification.filed', period: '2027-01' }),
        confirmedProjection,
      ),
    ).not.toThrow();
  });

  it('não interfere em competência aberta', () => {
    const aberta = projectionWith(
      makeEvent(0, 'period.opened', '2027-02', TEST_USER_ID, payloads.periodOpened('2027-02'), {
        period: '2027-02',
      }),
    );

    expect(() =>
      validator.validate(intention({ action: 'doc.received', period: '2027-02' }), aberta),
    ).not.toThrow();
  });
});

describe('Camada 7 — VerificationGateValidator', () => {
  const validator = new VerificationGateValidator(new FiscalHashVerifierService(projector));

  const events = [
    makeEvent(0, 'client.enrolled', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.clientEnrolled()),
  ];

  it('não exige hash de um log vazio', () => {
    expect(() => validator.validate([], projectionWith())).not.toThrow();
  });

  it('aceita projeção que fecha com o log', () => {
    expect(() => validator.validate(events, projectionWith(...events))).not.toThrow();
  });

  it('rejeita projeção cujo conteúdo foi adulterado', () => {
    const adulterada = projectionWith(...events);
    adulterada.client!.regime = 'lucro_real';

    expect(() => validator.validate(events, adulterada)).toThrow(/não fecha com o log/);
  });

  it('rejeita quando o log ganhou um evento que a projeção não contempla', () => {
    const projection = projectionWith(...events);
    const comIntruso = [
      ...events,
      makeEvent(1, 'doc.received', 'chave-x', TEST_USER_ID, { access_key: 'chave-x' }),
    ];

    expect(() => validator.validate(comIntruso, projection)).toThrow(/não fecha com o log/);
  });
});
