import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStoreRepository } from '../../../../src/esaa/core/event-store/jsonl-event-store.repository.js';
import { EventAppenderService } from '../../../../src/esaa/core/event-store/event-appender.service.js';
import { EventReplayerService } from '../../../../src/esaa/core/event-store/event-replayer.service.js';
import { EventScope } from '../../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import {
  TEST_SCOPE,
  OTHER_SCOPE,
  TEST_USER_ID,
  makeEvent,
  payloads,
} from '../../../helpers/scope.js';

describe('Event Store', () => {
  let tempDir: string;
  let repo: JsonlEventStoreRepository;

  const enrolled = (seq: number) =>
    makeEvent(seq, 'client.enrolled', TEST_SCOPE.cnpj, TEST_USER_ID, payloads.clientEnrolled());

  const opened = (seq: number, period = '2027-01') =>
    makeEvent(seq, 'period.opened', period, TEST_USER_ID, payloads.periodOpened(period), {
      period,
    });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'esaa-test-'));
    repo = new JsonlEventStoreRepository(join(tempDir, 'activity.jsonl'));
    await repo.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe('JsonlEventStoreRepository', () => {
    it('deve inicializar com arquivo vazio', async () => {
      expect(await repo.count()).toBe(0);
    });

    it('deve fazer append e recuperar eventos', async () => {
      await repo.append(enrolled(0));

      const all = await repo.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.action).toBe('client.enrolled');
      expect(all[0]!.tenant_id).toBe(TEST_SCOPE.tenantId);
      expect(all[0]!.cnpj).toBe(TEST_SCOPE.cnpj);
    });

    it('deve retornar eventos após seq específico', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.append(
          makeEvent(i, 'doc.received', `chave-${i}`, TEST_USER_ID, { access_key: `chave-${i}` }),
        );
      }

      const after2 = await repo.getAfterSeq(2);
      expect(after2).toHaveLength(2);
      expect(after2[0]!.event_seq).toBe(3);
    });

    it('deve retornar último seq', async () => {
      expect(await repo.getLastSeq()).toBe(-1);
      await repo.append(enrolled(0));
      expect(await repo.getLastSeq()).toBe(0);
    });

    it('preserva a competência quando o evento tem uma', async () => {
      await repo.append(opened(0, '2027-03'));

      const [event] = await repo.getAll();
      expect(event!.period).toBe('2027-03');
    });
  });

  describe('EventAppenderService', () => {
    it('deve auto-incrementar event_seq', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const first = await appender.append({
        action: 'client.enrolled',
        taskId: TEST_SCOPE.cnpj,
        actor: TEST_USER_ID,
        payload: payloads.clientEnrolled(),
      });
      const second = await appender.append({
        action: 'period.opened',
        taskId: '2027-01',
        actor: TEST_USER_ID,
        payload: payloads.periodOpened(),
        period: '2027-01',
      });

      expect(first.event_seq).toBe(0);
      expect(second.event_seq).toBe(1);
    });

    it('estampa o escopo em todo evento que grava', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const event = await appender.append({
        action: 'period.opened',
        taskId: '2027-01',
        actor: TEST_USER_ID,
        payload: payloads.periodOpened(),
        period: '2027-01',
      });

      expect(event.tenant_id).toBe(TEST_SCOPE.tenantId);
      expect(event.cnpj).toBe(TEST_SCOPE.cnpj);
      expect(event.period).toBe('2027-01');
    });

    it('omite period quando a intenção não informa competência', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const event = await appender.append({
        action: 'client.enrolled',
        taskId: TEST_SCOPE.cnpj,
        actor: TEST_USER_ID,
        payload: payloads.clientEnrolled(),
      });

      // Ausente, não `null`: o schema do evento tem additionalProperties false e
      // a canonicalização ignora undefined, então um null mudaria o hash sem
      // mudar o significado.
      expect('period' in event).toBe(false);
    });

    /**
     * Documenta de forma executável por que o JSONL não serve para produção: a
     * alocação é um read-modify-write sem lock, então escritas concorrentes
     * colidem no mesmo `event_seq`. O adapter Postgres resolve com advisory lock
     * por CNPJ (INV-005) e tem teste provando sequência densa.
     */
    it('NÃO é seguro para escrita concorrente: colide event_seq', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          appender.append({
            action: 'doc.received',
            taskId: `chave-${i}`,
            actor: TEST_USER_ID,
            payload: { access_key: `chave-${i}` },
          }),
        ),
      );

      expect(new Set(results.map((e) => e.event_seq)).size).toBeLessThan(results.length);
    });

    it('deve rejeitar seq fora de ordem no appendRaw', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      await expect(appender.appendRaw(enrolled(5))).rejects.toThrow('Gap detected');
    });

    it('deve rejeitar evento de outro tenant no appendRaw', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      const doOutro = makeEvent(
        0,
        'client.enrolled',
        OTHER_SCOPE.cnpj,
        TEST_USER_ID,
        payloads.clientEnrolled(),
        { scope: OTHER_SCOPE },
      );

      await expect(appender.appendRaw(doOutro)).rejects.toThrow(/fora do escopo/);
    });

    it('deve rejeitar evento do mesmo tenant mas de outro CNPJ', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      const outroCnpj = EventScope.create(TEST_SCOPE.tenantId, '11222333000181');
      const evento = makeEvent(
        0,
        'client.enrolled',
        outroCnpj.cnpj,
        TEST_USER_ID,
        payloads.clientEnrolled(),
        { scope: outroCnpj },
      );

      await expect(appender.appendRaw(evento)).rejects.toThrow(/fora do escopo/);
    });
  });

  describe('EventReplayerService', () => {
    it('deve replay todos os eventos em ordem', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      for (const period of ['2027-01', '2027-02', '2027-03']) {
        await appender.append({
          action: 'period.opened',
          taskId: period,
          actor: TEST_USER_ID,
          payload: payloads.periodOpened(period),
          period,
        });
      }

      const events = await new EventReplayerService(repo).replayAll();

      expect(events.map((e) => e.event_seq)).toEqual([0, 1, 2]);
    });

    it('deve replay eventos de uma entidade específica', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      await appender.append({
        action: 'period.opened',
        taskId: '2027-01',
        actor: TEST_USER_ID,
        payload: payloads.periodOpened('2027-01'),
        period: '2027-01',
      });
      await appender.append({
        action: 'period.opened',
        taskId: '2027-02',
        actor: TEST_USER_ID,
        payload: payloads.periodOpened('2027-02'),
        period: '2027-02',
      });
      await appender.append({
        action: 'doc.received',
        taskId: '2027-01',
        actor: TEST_USER_ID,
        payload: { access_key: 'x' },
        period: '2027-01',
      });

      const eventos = await new EventReplayerService(repo).replayForTask('2027-01');

      expect(eventos).toHaveLength(2);
      expect(eventos.every((e) => e.task_id === '2027-01')).toBe(true);
    });
  });
});
