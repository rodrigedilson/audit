import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlEventStoreRepository } from '../../../src/esaa/core/event-store/jsonl-event-store.repository.js';
import type { IEventStoreRepository } from '../../../src/esaa/core/event-store/event-store.repository.js';
import { ContractLoaderService } from '../../../src/esaa/core/contracts/contract-loader.service.js';
import { ESAAOrchestratorService } from '../../../src/esaa/orchestrator/esaa-orchestrator.service.js';
import { IntegrityViolationError } from '../../../src/esaa/shared/types/esaa-errors.js';
import type { ESAAEventData } from '../../../src/esaa/shared/types/esaa-event.types.js';
import { TEST_SCOPE } from '../../helpers/scope.js';

/**
 * Um escritor concorrente é a única forma realista de a projeção divergir do log
 * sem que ninguém tenha adulterado arquivo: o orquestrador projeta o que leu, e um
 * segundo processo acrescenta um evento antes da verificação. Sem INV-005
 * implementado, nada impede isso hoje — então o mínimo é que o orquestrador
 * **perceba** e pare, em vez de devolver um número sem trilha.
 *
 * Este decorador injeta o evento do intruso numa leitura específica, reproduzindo a
 * corrida de forma determinística.
 */
class RaceInjectingStore implements IEventStoreRepository {
  private reads = 0;

  constructor(
    private readonly inner: IEventStoreRepository,
    private readonly injectOnRead: number,
  ) {}

  async getAll(): Promise<ESAAEventData[]> {
    this.reads += 1;
    const events = await this.inner.getAll();

    if (this.reads !== this.injectOnRead) {
      return events;
    }

    const intruder: ESAAEventData = {
      event_id: randomUUID(),
      event_seq: events.length,
      action: 'task.create',
      task_id: 'T-9999',
      actor: 'tech-lead',
      ts: new Date().toISOString(),
      schema_version: '0.4.0',
      tenant_id: TEST_SCOPE.tenantId,
      cnpj: TEST_SCOPE.cnpj,
      payload: {
        kind: 'impl',
        description: 'Task gravada por um escritor concorrente',
        assigned_agent: 'coder',
        parent_run: 'run-001',
      },
    };

    return [...events, intruder];
  }

  append(event: ESAAEventData): Promise<void> {
    return this.inner.append(event);
  }
  async getAfterSeq(seq: number): Promise<ESAAEventData[]> {
    return (await this.getAll()).filter((e) => e.event_seq > seq);
  }
  async getLastSeq(): Promise<number> {
    return this.inner.getLastSeq();
  }
  async getByTaskId(taskId: string): Promise<ESAAEventData[]> {
    return (await this.getAll()).filter((e) => e.task_id === taskId);
  }
  async count(): Promise<number> {
    return (await this.getAll()).length;
  }
}

describe('ESAAOrchestratorService — integridade (INV-006)', () => {
  let tempDir: string;
  let inner: JsonlEventStoreRepository;
  let contractLoader: ContractLoaderService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'esaa-integrity-'));
    inner = new JsonlEventStoreRepository(join(tempDir, 'activity.jsonl'));
    await inner.initialize();

    contractLoader = new ContractLoaderService();
    await contractLoader.loadAgentContract(join(process.cwd(), 'config', 'AGENT_CONTRACT.yaml'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const runStart = {
    action: 'run.start' as const,
    task_id: 'run-001',
    actor: 'tech-lead',
    payload: { run_id: 'run-001', phase_name: 'Fechamento', objectives: [] },
  };

  it('aceita a intenção quando o log e a projeção fecham', async () => {
    const orchestrator = new ESAAOrchestratorService(inner, contractLoader, TEST_SCOPE);
    await orchestrator.initialize();

    const result = await orchestrator.processIntention(runStart);

    expect(result.accepted).toBe(true);
    await expect(orchestrator.verify()).resolves.toMatchObject({ valid: true });
  });

  it('interrompe com IntegrityViolationError quando um escritor concorrente entra entre a projeção e a verificação', async () => {
    // Leituras de processIntention: 1 validação, 2 reprojeção, 3 verificação.
    // Injetar na 3ª faz a verificação ver um log que a projeção não contempla.
    const racing = new RaceInjectingStore(inner, 3);
    const orchestrator = new ESAAOrchestratorService(racing, contractLoader, TEST_SCOPE);
    await orchestrator.initialize();

    await expect(orchestrator.processIntention(runStart)).rejects.toThrow(IntegrityViolationError);
  });

  it('não engole a divergência: o erro carrega os dois hashes', async () => {
    const racing = new RaceInjectingStore(inner, 3);
    const orchestrator = new ESAAOrchestratorService(racing, contractLoader, TEST_SCOPE);
    await orchestrator.initialize();

    const error = await orchestrator.processIntention(runStart).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IntegrityViolationError);
    const violation = error as IntegrityViolationError;
    expect(violation.code).toBe('INTEGRITY_VIOLATION');
    expect(violation.expectedHash).not.toBe(violation.actualHash);
    expect(violation.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(violation.actualHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verify() devolve os campos que o POST /verify do contrato expõe', async () => {
    const orchestrator = new ESAAOrchestratorService(inner, contractLoader, TEST_SCOPE);
    await orchestrator.initialize();
    await orchestrator.processIntention(runStart);

    const report = await orchestrator.verify();

    expect(report).toMatchObject({ valid: true, eventCount: 1, lastEventSeq: 0 });
    expect(report.storedHash).toBe(report.replayedHash);
    expect(report.contentHash).toBe(report.storedHash);
  });
});
