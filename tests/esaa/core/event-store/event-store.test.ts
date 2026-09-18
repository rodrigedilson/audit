import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStoreRepository } from '../../../../src/esaa/core/event-store/jsonl-event-store.repository.js';
import { EventAppenderService } from '../../../../src/esaa/core/event-store/event-appender.service.js';
import { EventReplayerService } from '../../../../src/esaa/core/event-store/event-replayer.service.js';
import { EventScope } from '../../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import { TEST_SCOPE, OTHER_SCOPE, makeEvent } from '../../../helpers/scope.js';

describe('Event Store', () => {
  let tempDir: string;
  let filePath: string;
  let repo: JsonlEventStoreRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'esaa-test-'));
    filePath = join(tempDir, 'activity.jsonl');
    repo = new JsonlEventStoreRepository(filePath);
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
      await repo.append(
        makeEvent(0, 'run.start', 'run-001', 'tech-lead', {
          run_id: 'run-001',
          phase_name: 'test',
          objectives: [],
        }),
      );

      const all = await repo.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.action).toBe('run.start');
      expect(all[0]!.actor).toBe('tech-lead');
      expect(all[0]!.tenant_id).toBe(TEST_SCOPE.tenantId);
      expect(all[0]!.cnpj).toBe(TEST_SCOPE.cnpj);
    });

    it('deve retornar eventos após seq específico', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.append(
          makeEvent(i, 'task.create', `T-${i}`, 'tech-lead', {
            kind: 'impl',
            description: `Task ${i}`,
            assigned_agent: 'coder',
            parent_run: 'run-001',
          }),
        );
      }

      const after2 = await repo.getAfterSeq(2);
      expect(after2).toHaveLength(2);
      expect(after2[0]!.event_seq).toBe(3);
    });

    it('deve retornar último seq', async () => {
      expect(await repo.getLastSeq()).toBe(-1);

      await repo.append(
        makeEvent(0, 'run.start', 'run-001', 'tech-lead', {
          run_id: 'run-001',
          phase_name: 'test',
          objectives: [],
        }),
      );

      expect(await repo.getLastSeq()).toBe(0);
    });

    it('preserva a competência quando o evento tem uma', async () => {
      await repo.append(
        makeEvent(0, 'task.create', 'T-1', 'tech-lead', {
          kind: 'impl',
          description: 'Apuração',
          assigned_agent: 'coder',
          parent_run: 'run-001',
        }, { period: '2027-01' }),
      );

      const [event] = await repo.getAll();
      expect(event!.period).toBe('2027-01');
    });
  });

  describe('EventAppenderService', () => {
    it('deve auto-incrementar event_seq', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const evt1 = await appender.append({
        action: 'run.start',
        taskId: 'run-001',
        actor: 'tech-lead',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
      });
      const evt2 = await appender.append({
        action: 'task.create',
        taskId: 'T-1000',
        actor: 'tech-lead',
        payload: {
          kind: 'impl',
          description: 'Test',
          assigned_agent: 'coder',
          parent_run: 'run-001',
        },
      });

      expect(evt1.event_seq).toBe(0);
      expect(evt2.event_seq).toBe(1);
    });

    it('estampa o escopo em todo evento que grava', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const event = await appender.append({
        action: 'run.start',
        taskId: 'run-001',
        actor: 'tech-lead',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
        period: '2027-01',
      });

      expect(event.tenant_id).toBe(TEST_SCOPE.tenantId);
      expect(event.cnpj).toBe(TEST_SCOPE.cnpj);
      expect(event.period).toBe('2027-01');
    });

    it('omite period quando a intenção não informa competência', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const event = await appender.append({
        action: 'run.start',
        taskId: 'run-001',
        actor: 'tech-lead',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
      });

      // Ausente, não `null`: o schema do evento tem additionalProperties false e a
      // canonicalização ignora undefined, então um null mudaria o hash sem mudar o
      // significado.
      expect('period' in event).toBe(false);
    });

    /**
     * Documenta, de forma executável, por que o JSONL não serve para produção: a
     * alocação é um read-modify-write sem lock, então escritas concorrentes
     * colidem no mesmo `event_seq`. O adapter Postgres resolve isso com advisory
     * lock por CNPJ (INV-005) e tem teste equivalente provando sequência densa.
     *
     * Se algum dia este teste começar a falhar porque não há mais colisão, ou o
     * JSONL ganhou atomicidade — e o comentário acima precisa mudar — ou o teste
     * deixou de exercitar concorrência.
     */
    it('NÃO é seguro para escrita concorrente: colide event_seq', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          appender.append({
            action: 'task.create',
            taskId: `T-${i}`,
            actor: 'tech-lead',
            payload: {
              kind: 'impl',
              description: `Task ${i}`,
              assigned_agent: 'coder',
              parent_run: 'run-001',
            },
          }),
        ),
      );

      const distintos = new Set(results.map((e) => e.event_seq)).size;
      expect(distintos).toBeLessThan(results.length);
    });

    it('deve rejeitar seq fora de ordem no appendRaw', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      await expect(
        appender.appendRaw(
          makeEvent(5, 'run.start', 'run-001', 'tech-lead', {
            run_id: 'run-001',
            phase_name: 'test',
            objectives: [],
          }),
        ),
      ).rejects.toThrow('Gap detected');
    });

    /**
     * Um evento de outro escopo consumiria um `event_seq` da sequência errada e
     * quebraria o replay determinístico dos dois escopos — além do vazamento.
     */
    it('deve rejeitar evento de outro tenant no appendRaw', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);

      await expect(
        appender.appendRaw(
          makeEvent(0, 'run.start', 'run-001', 'tech-lead', {
            run_id: 'run-001',
            phase_name: 'test',
            objectives: [],
          }, { scope: OTHER_SCOPE }),
        ),
      ).rejects.toThrow(/fora do escopo/);
    });

    it('deve rejeitar evento do mesmo tenant mas de outro CNPJ', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      const sameTenantOtherCnpj = EventScope.create(TEST_SCOPE.tenantId, '11222333000181');

      await expect(
        appender.appendRaw(
          makeEvent(0, 'run.start', 'run-001', 'tech-lead', {
            run_id: 'run-001',
            phase_name: 'test',
            objectives: [],
          }, { scope: sameTenantOtherCnpj }),
        ),
      ).rejects.toThrow(/fora do escopo/);
    });
  });

  describe('EventReplayerService', () => {
    const appendAll = async (appender: EventAppenderService): Promise<void> => {
      await appender.append({
        action: 'run.start',
        taskId: 'run-001',
        actor: 'tech-lead',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
      });
      await appender.append({
        action: 'task.create',
        taskId: 'T-1000',
        actor: 'tech-lead',
        payload: {
          kind: 'impl',
          description: 'Test',
          assigned_agent: 'coder',
          parent_run: 'run-001',
        },
      });
    };

    it('deve replay todos os eventos em ordem', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      await appendAll(appender);
      await appender.append({
        action: 'claim',
        taskId: 'T-1000',
        actor: 'coder',
        payload: { reason: 'assigned' },
      });

      const events = await new EventReplayerService(repo).replayAll();

      expect(events).toHaveLength(3);
      expect(events.map((e) => e.event_seq)).toEqual([0, 1, 2]);
    });

    it('deve replay eventos de uma tarefa específica', async () => {
      const appender = new EventAppenderService(repo, TEST_SCOPE);
      await appendAll(appender);
      await appender.append({
        action: 'task.create',
        taskId: 'T-1001',
        actor: 'tech-lead',
        payload: {
          kind: 'qa',
          description: 'QA',
          assigned_agent: 'tester',
          parent_run: 'run-001',
        },
      });
      await appender.append({
        action: 'claim',
        taskId: 'T-1000',
        actor: 'coder',
        payload: {},
      });

      const t1000Events = await new EventReplayerService(repo).replayForTask('T-1000');

      expect(t1000Events).toHaveLength(2);
      expect(t1000Events.every((e) => e.task_id === 'T-1000')).toBe(true);
    });
  });
});
