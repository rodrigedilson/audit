import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../src/esaa/shared/types/esaa-errors.js';
import { JsonParseValidator } from '../../../../src/esaa/core/validation/validators/json-parse.validator.js';
import { SchemaValidator } from '../../../../src/esaa/core/validation/validators/schema.validator.js';
import { VocabularyValidator } from '../../../../src/esaa/core/validation/validators/vocabulary.validator.js';
import { StateMachineValidator } from '../../../../src/esaa/core/validation/validators/state-machine.validator.js';
import { isInternal } from '../../../../src/fiscal/shared/evaluation-criterion.js';
import type { ESAAIntention } from '../../../../src/esaa/shared/types/esaa-event.types.js';
import type { FiscalProjection } from '../../../../src/fiscal/shared/fiscal-projection.types.js';

/**
 * Uma rejeição sem critério diz ao contador *que* o documento não passou e não
 * diz *contra o quê* — e é contra o quê que ele precisa responder ao cliente,
 * ou ao Fisco. Estes testes fixam que as camadas que fazem juízo citam a fonte.
 */

function capturar(fn: () => void): ValidationError {
  try {
    fn();
  } catch (erro) {
    if (erro instanceof ValidationError) {
      return erro;
    }
    throw erro;
  }
  throw new Error('esperava ValidationError, e nada foi lançado');
}

const intencao = (over: Partial<ESAAIntention> = {}): ESAAIntention =>
  ({
    action: 'client.enrolled',
    task_id: '11222333000181',
    actor: '3f4a1c2e-0000-4000-8000-000000000001',
    payload: {},
    ...over,
  }) as ESAAIntention;

describe('critério nas camadas do pipeline', () => {
  it('camada 1 cita o contrato da intenção, não uma lei', () => {
    const erro = capturar(() => new JsonParseValidator().validate(null));

    expect(erro.layer).toBe(1);
    expect(erro.criterion?.criterionId).toBe('contrato-intencao');
    // Recusa de forma não é juízo fiscal: citar lei aqui seria invenção.
    expect(erro.criterion?.kind).toBe('contrato_de_api');
  });

  it('camada 2 também cita o contrato', () => {
    const erro = capturar(() =>
      new SchemaValidator().validate(intencao({ actor: '   ' })),
    );

    expect(erro.layer).toBe(2);
    expect(erro.criterion?.criterionId).toBe('contrato-intencao');
  });

  it('camada 3 cita o vocabulário quando a ação não existe', () => {
    const erro = capturar(() =>
      new VocabularyValidator().validate(intencao({ action: 'nao.existe' })),
    );

    expect(erro.layer).toBe(3);
    expect(erro.criterion?.criterionId).toBe('vocabulario-fechado');
  });

  /**
   * Esta é a rejeição que sustenta o argumento de governança do produto —
   * nenhuma IA altera um número fiscal sozinha. Ela precisa citar a decisão que
   * a torna verdadeira, e não o vocabulário genérico.
   */
  it('camada 3 cita a separação entre propor e efetivar quando um agente tenta efetivar', () => {
    const erro = capturar(() =>
      new VocabularyValidator().validate(
        intencao({ action: 'assessment.confirmed', actor: 'classifier' }),
      ),
    );

    expect(erro.layer).toBe(3);
    expect(erro.criterion?.criterionId).toBe('proposta-e-efetivacao');
    expect(erro.criterion?.citation).toBe('Separação entre proposta e efetivação');
  });

  it('camada 4 cita o ciclo da competência numa transição inválida', () => {
    const projecao = {
      periods: {},
      cnpj: '11222333000181',
    } as unknown as FiscalProjection;

    const erro = capturar(() =>
      new StateMachineValidator().validate(
        intencao({ action: 'assessment.projected', period: '2027-01' }),
        projecao,
      ),
    );

    expect(erro.layer).toBe(4);
    expect(erro.criterion?.criterionId).toBe('ciclo-da-competencia');
  });

  it('camada 4 cita o contrato, e não o ciclo, quando a competência está malformada', () => {
    const projecao = { periods: {}, cnpj: '11222333000181' } as unknown as FiscalProjection;

    const erro = capturar(() =>
      new StateMachineValidator().validate(
        intencao({ action: 'period.opened', period: '2027-13' }),
        projecao,
      ),
    );

    expect(erro.criterion?.criterionId).toBe('contrato-intencao');
  });

  it('todo critério citado pelas camadas é interno e conferível neste repositório', () => {
    const erros = [
      capturar(() => new JsonParseValidator().validate(null)),
      capturar(() => new VocabularyValidator().validate(intencao({ action: 'x' }))),
    ];

    for (const erro of erros) {
      expect(erro.criterion).toBeDefined();
      expect(isInternal(erro.criterion!.kind)).toBe(true);
      expect(erro.criterion!.sourceRef).not.toBeNull();
    }
  });
});
