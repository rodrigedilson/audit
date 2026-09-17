import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStoreRepository } from '../../../../src/esaa/core/event-store/jsonl-event-store.repository.js';
import { EventAppenderService } from '../../../../src/esaa/core/event-store/event-appender.service.js';
import { EventReplayerService } from '../../../../src/esaa/core/event-store/event-replayer.service.js';

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
      const count = await repo.count();
      expect(count).toBe(0);
    });

    it('deve fazer append e recuperar eventos', async () => {
      await repo.append({
        event_id: 'evt-1',
        event_seq: 0,
        action: 'run.start',
        task_id: 'run-001',
        actor: 'tech-lead',
        ts: new Date().toISOString(),
        schema_version: '0.4.0',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
      });

      const all = await repo.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].action).toBe('run.start');
      expect(all[0].actor).toBe('tech-lead');
    });

    it('deve retornar eventos após seq específico', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.append({
          event_id: `evt-${i}`,
          event_seq: i,
          action: 'task.create',
          task_id: `T-${i}`,
          actor: 'tech-lead',
          ts: new Date().toISOString(),
          schema_version: '0.4.0',
          payload: { kind: 'impl', description: `Task ${i}`, assigned_agent: 'coder', parent_run: 'run-001' },
        });
      }

      const after2 = await repo.getAfterSeq(2);
      expect(after2).toHaveLength(2);
      expect(after2[0].event_seq).toBe(3);
    });

    it('deve retornar último seq', async () => {
      expect(await repo.getLastSeq()).toBe(-1);

      await repo.append({
        event_id: 'evt-0',
        event_seq: 0,
        action: 'run.start',
        task_id: 'run-001',
        actor: 'tech-lead',
        ts: new Date().toISOString(),
        schema_version: '0.4.0',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
      });

      expect(await repo.getLastSeq()).toBe(0);
    });
  });

  describe('EventAppenderService', () => {
    it('deve auto-incrementar event_seq', async () => {
      const appender = new EventAppenderService(repo);

      const evt1 = await appender.append('run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'test', objectives: [],
      });
      const evt2 = await appender.append('task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Test', assigned_agent: 'coder', parent_run: 'run-001',
      });

      expect(evt1.event_seq).toBe(0);
      expect(evt2.event_seq).toBe(1);
    });

    it('deve rejeitar seq fora de ordem no appendRaw', async () => {
      const appender = new EventAppenderService(repo);

      await expect(appender.appendRaw({
        event_id: 'evt-bad',
        event_seq: 5,
        action: 'run.start',
        task_id: 'run-001',
        actor: 'tech-lead',
        ts: new Date().toISOString(),
        schema_version: '0.4.0',
        payload: { run_id: 'run-001', phase_name: 'test', objectives: [] },
      })).rejects.toThrow('Gap detected');
    });
  });

  describe('EventReplayerService', () => {
    it('deve replay todos os eventos em ordem', async () => {
      const appender = new EventAppenderService(repo);
      await appender.append('run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'test', objectives: [],
      });
      await appender.append('task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Test', assigned_agent: 'coder', parent_run: 'run-001',
      });
      await appender.append('claim', 'T-1000', 'coder', { reason: 'assigned' });

      const replayer = new EventReplayerService(repo);
      const events = await replayer.replayAll();

      expect(events).toHaveLength(3);
      expect(events[0].event_seq).toBe(0);
      expect(events[1].event_seq).toBe(1);
      expect(events[2].event_seq).toBe(2);
    });

    it('deve replay eventos de uma tarefa específica', async () => {
      const appender = new EventAppenderService(repo);
      await appender.append('run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'test', objectives: [],
      });
      await appender.append('task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Test', assigned_agent: 'coder', parent_run: 'run-001',
      });
      await appender.append('task.create', 'T-1001', 'tech-lead', {
        kind: 'qa', description: 'QA', assigned_agent: 'tester', parent_run: 'run-001',
      });
      await appender.append('claim', 'T-1000', 'coder', {});

      const replayer = new EventReplayerService(repo);
      const t1000Events = await replayer.replayForTask('T-1000');

      expect(t1000Events).toHaveLength(2);
      expect(t1000Events.every(e => e.task_id === 'T-1000')).toBe(true);
    });
  });
});
