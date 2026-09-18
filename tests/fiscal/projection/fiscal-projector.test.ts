import { describe, it, expect } from 'vitest';
import {
  FiscalProjectorService,
  EMPTY_PROJECTION_TIMESTAMP,
  ProjectionError,
} from '../../../src/fiscal/projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../../../src/fiscal/projection/fiscal-hash-verifier.service.js';
import { TEST_SCOPE, TEST_USER_ID, makeEvent, payloads } from '../../helpers/scope.js';
import type { ESAAEventData } from '../../../src/esaa/shared/types/esaa-event.types.js';

const projector = new FiscalProjectorService();

const project = (events: ESAAEventData[]) =>
  projector.project(TEST_SCOPE.tenantId, TEST_SCOPE.cnpj, events);

const enrolled = (seq = 0) =>
  makeEvent(seq, 'client.enrolled', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.clientEnrolled());

const opened = (seq: number, period: string) =>
  makeEvent(seq, 'period.opened', period, TEST_USER_ID, payloads.periodOpened(period), { period });

describe('FiscalProjectorService — cadastro do cliente', () => {
  it('projeta log vazio sem cliente e com timestamp constante', () => {
    const projection = project([]);

    expect(projection.client).toBeNull();
    expect(projection.last_event_seq).toBe(-1);
    expect(projection.last_updated).toBe(EMPTY_PROJECTION_TIMESTAMP);
    expect(projection.tenant_id).toBe(TEST_SCOPE.tenantId);
    expect(projection.cnpj).toBe(TEST_SCOPE.cnpj);
  });

  it('projeta o cadastro a partir de client.enrolled', () => {
    const projection = project([enrolled()]);

    expect(projection.client).toMatchObject({
      legal_name: 'Cliente de Teste',
      regime: 'simples_hibrido',
      uf: 'SP',
      status: 'active',
      enrolled_by: TEST_USER_ID,
    });
  });

  it('aplica alteração de regime com vigência, sem perder o cadastro', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'client.updated', TEST_SCOPE.cnpj, TEST_USER_ID, {
        regime: 'lucro_presumido',
        regime_effective_from: '2028-01',
      }),
    ]);

    expect(projection.client?.regime).toBe('lucro_presumido');
    expect(projection.client?.regime_effective_from).toBe('2028-01');
    expect(projection.client?.legal_name).toBe('Cliente de Teste');
  });

  it('ignora client.updated antes do cadastro, em vez de inventar um cliente', () => {
    const projection = project([
      makeEvent(0, 'client.updated', TEST_SCOPE.cnpj, TEST_USER_ID, { trade_name: 'Fantasia' }),
    ]);

    expect(projection.client).toBeNull();
  });

  it('acumula alertas do cliente', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'client.alert', TEST_SCOPE.cnpj, TEST_USER_ID, {
        alert_id: 'a1',
        kind: 'cnae_impeditivo',
        severity: 'high',
        message: 'CNAE 6201-5/01 é impeditivo para o Simples',
      }),
    ]);

    expect(projection.alerts).toHaveLength(1);
    expect(projection.alerts[0]).toMatchObject({ kind: 'cnae_impeditivo', severity: 'high' });
  });
});

describe('FiscalProjectorService — ciclo da competência', () => {
  const ciclo = (period = '2027-01'): ESAAEventData[] => [
    enrolled(),
    opened(1, period),
    makeEvent(2, 'assessment.projected', period, TEST_USER_ID, {}, { period }),
    makeEvent(3, 'assessment.compared', period, TEST_USER_ID, {}, { period }),
    makeEvent(
      4,
      'assessment.confirmed',
      period,
      TEST_USER_ID,
      { period, projection_hash: 'hash-da-tela' },
      { period },
    ),
  ];

  it('percorre open → assessed → reconciled → confirmed', () => {
    const period = '2027-01';
    const events = ciclo(period);

    expect(project(events.slice(0, 2)).periods[period]?.state).toBe('open');
    expect(project(events.slice(0, 3)).periods[period]?.state).toBe('assessed');
    expect(project(events.slice(0, 4)).periods[period]?.state).toBe('reconciled');
    expect(project(events).periods[period]?.state).toBe('confirmed');
  });

  it('registra quem confirmou, quando e com qual hash', () => {
    const projection = project(ciclo());
    const period = projection.periods['2027-01'];

    expect(period?.confirmed_by).toBe(TEST_USER_ID);
    expect(period?.confirmed_at).toBeTruthy();
    expect(period?.projection_hash).toBe('hash-da-tela');
  });

  it('conta competências por estado', () => {
    const projection = project([
      enrolled(),
      opened(1, '2027-01'),
      opened(2, '2027-02'),
      makeEvent(3, 'assessment.projected', '2027-02', TEST_USER_ID, {}, { period: '2027-02' }),
    ]);

    expect(projection.stats).toMatchObject({
      periods_total: 2,
      periods_open: 1,
      periods_assessed: 1,
      periods_confirmed: 0,
    });
  });

  /**
   * INV-001 na projeção: a competência original **não** volta para `open` nem
   * perde o hash. É o que permite ao escritório mostrar o que entregou na época
   * e o que corrigiu depois, sem reescrever a história.
   */
  it('retificação aponta para a nova competência sem alterar a original', () => {
    const events: ESAAEventData[] = [
      ...ciclo('2027-01'),
      makeEvent(5, 'rectification.filed', '2027-01', TEST_USER_ID, {
        original_period: '2027-01',
        rectification_period: '2027-01-R1',
        reason: 'Nota de entrada recebida após o fechamento',
        original_projection_hash: 'hash-da-tela',
      }),
    ];

    const original = project(events).periods['2027-01'];

    expect(original?.state).toBe('confirmed');
    expect(original?.projection_hash).toBe('hash-da-tela');
    expect(original?.rectified_by).toBe('2027-01-R1');
  });
});

describe('FiscalProjectorService — cofre de certificados', () => {
  it('projeta o certificado armazenado e conta usos', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'certificate.stored', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.certificateStored()),
      makeEvent(2, 'certificate.used', TEST_SCOPE.cnpj, 'collector', payloads.certificateUsed()),
      makeEvent(3, 'certificate.used', TEST_SCOPE.cnpj, 'collector', payloads.certificateUsed()),
    ]);

    expect(projection.certificate).toMatchObject({ serial: 'A1B2C3', usage_count: 2 });
    expect(projection.stats.certificate_uses).toBe(2);
  });

  /** Falha de autenticação não é evidência de que o certificado funcionou. */
  it('uso com falha conta como uso mas não move o último uso bem-sucedido', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'certificate.stored', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.certificateStored()),
      makeEvent(2, 'certificate.used', TEST_SCOPE.cnpj, 'collector', payloads.certificateUsed('failure')),
    ]);

    expect(projection.certificate?.usage_count).toBe(1);
    expect(projection.certificate?.last_used_at).toBeUndefined();
  });

  it('remoção zera o certificado mas preserva a contagem histórica de usos', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'certificate.stored', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.certificateStored()),
      makeEvent(2, 'certificate.used', TEST_SCOPE.cnpj, 'collector', payloads.certificateUsed()),
      makeEvent(3, 'certificate.removed', TEST_SCOPE.cnpj, TEST_USER_ID, {}),
    ]);

    expect(projection.certificate).toBeNull();
    // O uso aconteceu e o log o registra; apagar a contagem apagaria a trilha.
    expect(projection.stats.certificate_uses).toBe(1);
  });
});

describe('FiscalProjectorService — determinismo e integridade', () => {
  const events = [enrolled(), opened(1, '2027-01')];

  it('o mesmo log rende sempre o mesmo hash', () => {
    expect(project(events).projection_hash_sha256).toBe(project(events).projection_hash_sha256);
  });

  it('instâncias distintas do projetor concordam', () => {
    expect(
      new FiscalProjectorService().project(TEST_SCOPE.tenantId, TEST_SCOPE.cnpj, events)
        .projection_hash_sha256,
    ).toBe(
      new FiscalProjectorService().project(TEST_SCOPE.tenantId, TEST_SCOPE.cnpj, events)
        .projection_hash_sha256,
    );
  });

  /**
   * O escopo entra no objeto hasheado: sem isso, a projeção de um CNPJ poderia
   * ser apresentada como prova de outro caso os dois tivessem o mesmo conteúdo.
   */
  it('o hash é amarrado ao escopo', () => {
    const doOutro = projector.project('22222222-2222-2222-2222-222222222222', '98765432000110', []);

    expect(doOutro.projection_hash_sha256).not.toBe(project([]).projection_hash_sha256);
  });

  it('log vazio de dois CNPJs diferentes não colide', () => {
    const a = projector.project(TEST_SCOPE.tenantId, '11111111111111', []);
    const b = projector.project(TEST_SCOPE.tenantId, '22222222222222', []);

    expect(a.projection_hash_sha256).not.toBe(b.projection_hash_sha256);
  });

  it('adulterar a projeção quebra a verificação', () => {
    const verifier = new FiscalHashVerifierService(projector);
    const projection = project(events);

    expect(verifier.verify(events, projection).valid).toBe(true);

    projection.periods['2027-01']!.state = 'confirmed';
    const result = verifier.verify(events, projection);

    expect(result.valid).toBe(false);
    // Log intacto: quem denuncia é o hash do conteúdo.
    expect(result.replayHash).toBe(result.storedHash);
    expect(result.contentHash).not.toBe(result.storedHash);
  });

  it('ação desconhecida interrompe a projeção em vez de ser ignorada', () => {
    const invalido = {
      ...enrolled(),
      action: 'apuracao.inventada',
    } as unknown as ESAAEventData;

    // Num log fiscal, descartar um evento em silêncio produz apuração que omite
    // documento — e o hash atestaria esse número incompleto.
    expect(() => project([invalido])).toThrow(ProjectionError);
  });
});

describe('FiscalProjectorService — contadores dos demais contexts', () => {
  it('conta documentos recebidos e itens classificados', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'doc.received', 'chave-1', TEST_USER_ID, { access_key: 'chave-1' }),
      makeEvent(2, 'doc.received', 'chave-2', TEST_USER_ID, { access_key: 'chave-2' }),
      makeEvent(3, 'item.classified', 'item-1', TEST_USER_ID, {}),
    ]);

    expect(projection.stats.documents_received).toBe(2);
    expect(projection.stats.items_classified).toBe(1);
  });

  it('conta rejeições do pipeline', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'output.rejected', 'chave-1', TEST_USER_ID, {
        reason: 'code_incompatible',
        details: 'CST 000 incompatível com cClassTrib 200001',
        original_action: 'doc.received',
        validation_layer: 3,
      }),
    ]);

    expect(projection.stats.rejected_count).toBe(1);
  });

  it('propostas de agente entram no log sem efetivar estado', () => {
    const projection = project([
      enrolled(),
      makeEvent(1, 'item.classify', 'item-1', 'classifier', { ncm: '84713012' }),
    ]);

    expect(projection.stats.items_classified).toBe(0);
    expect(projection.last_event_seq).toBe(1);
  });
});
