import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStoreRepository } from '../../src/esaa/core/event-store/jsonl-event-store.repository.js';
import { ContractLoaderService } from '../../src/esaa/core/contracts/contract-loader.service.js';
import { ESAAOrchestratorService } from '../../src/esaa/orchestrator/esaa-orchestrator.service.js';
import { QueenOrchestratorAdapter } from '../../src/esaa/bridge/hive-mind/queen-orchestrator.adapter.js';
import { WorkerAgentAdapter } from '../../src/esaa/bridge/hive-mind/worker-agent.adapter.js';
import { PhaseToRunMapper } from '../../src/esaa/bridge/gsd/phase-to-run.mapper.js';

describe('ESAA Full Workflow E2E', () => {
  let tempDir: string;
  let repo: JsonlEventStoreRepository;
  let orchestrator: ESAAOrchestratorService;
  let contractLoader: ContractLoaderService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'esaa-e2e-'));
    const filePath = join(tempDir, 'activity.jsonl');
    repo = new JsonlEventStoreRepository(filePath);
    await repo.initialize();

    contractLoader = new ContractLoaderService();
    await contractLoader.loadAgentContract(join(process.cwd(), 'config', 'AGENT_CONTRACT.yaml'));

    orchestrator = new ESAAOrchestratorService(repo, contractLoader);
    await orchestrator.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('deve executar fluxo completo: GSD Phase → ESAA Run → Agents → Done', async () => {
    // 1. GSD Phase mapping
    const mapper = new PhaseToRunMapper();
    const intentions = mapper.mapPhaseToIntentions({
      id: '001',
      name: 'Feature Authentication',
      objectives: ['Implementar login JWT', 'Criar endpoints de auth'],
      tasks: [
        { id: '1000', description: 'Especificar API de auth', assignee: 'architect' },
        { id: '1001', description: 'Implementar auth service', assignee: 'coder' },
        { id: '1002', description: 'Testar auth endpoints', assignee: 'tester' },
      ],
    });

    expect(intentions).toHaveLength(4); // 1 run.start + 3 task.create

    // 2. Process all intentions via orchestrator
    for (const intention of intentions) {
      const result = await orchestrator.processIntention(intention);
      expect(result.accepted).toBe(true);
    }

    // 3. Architect claims and completes spec
    const queen = new QueenOrchestratorAdapter(orchestrator);
    const architect = new WorkerAgentAdapter(orchestrator, 'architect');

    const claimResult = await architect.claimTask('T-1000');
    expect(claimResult.accepted).toBe(true);

    const completeResult = await architect.completeTask('T-1000', ['docs/spec/auth.md'], ['schema_valid']);
    expect(completeResult.accepted).toBe(true);

    // 4. Reviewer approves spec
    const reviewResult = await orchestrator.processIntention({
      action: 'review',
      task_id: 'T-1000',
      actor: 'reviewer',
      payload: { verdict: 'approve', comments: 'Spec looks good' },
    });
    expect(reviewResult.accepted).toBe(true);

    // 5. Verify roadmap shows correct states
    const roadmap = await orchestrator.getRoadmap();
    expect(roadmap.tasks['T-1000'].state).toBe('done');
    expect(roadmap.tasks['T-1001'].state).toBe('todo');
    expect(roadmap.tasks['T-1002'].state).toBe('todo');
    expect(roadmap.stats.done).toBe(1);
    expect(roadmap.stats.todo).toBe(2);

    // 6. Verify integrity via hash
    const verification = await orchestrator.verify();
    expect(verification.valid).toBe(true);
    expect(verification.eventCount).toBeGreaterThan(0);
  });

  it('deve rejeitar agente tentando escrever fora do boundary', async () => {
    // Setup run
    await orchestrator.processIntention({
      action: 'run.start',
      task_id: 'run-002',
      actor: 'tech-lead',
      payload: { run_id: 'run-002', phase_name: 'Test', objectives: [] },
    });

    await orchestrator.processIntention({
      action: 'task.create',
      task_id: 'T-2000',
      actor: 'tech-lead',
      payload: { kind: 'spec', description: 'Spec task', assigned_agent: 'architect', parent_run: 'run-002' },
    });

    // Architect claims
    await orchestrator.processIntention({
      action: 'claim',
      task_id: 'T-2000',
      actor: 'architect',
      payload: {},
    });

    // Architect tries to complete with file_updates in src/ (forbidden for spec agents)
    const result = await orchestrator.processIntention({
      action: 'complete',
      task_id: 'T-2000',
      actor: 'architect',
      payload: { deliverables: ['src/hack.ts'], checks_passed: ['none'], verification_count: 1 },
      file_updates: [{ path: 'src/hack.ts', content: 'hacked' }],
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toContain('boundary');
  });

  it('deve rejeitar mutação de task done (imutabilidade)', async () => {
    // Setup: create task and move to done
    await orchestrator.processIntention({
      action: 'run.start', task_id: 'run-003', actor: 'tech-lead',
      payload: { run_id: 'run-003', phase_name: 'Immut Test', objectives: [] },
    });
    await orchestrator.processIntention({
      action: 'task.create', task_id: 'T-3000', actor: 'tech-lead',
      payload: { kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-003' },
    });
    await orchestrator.processIntention({
      action: 'claim', task_id: 'T-3000', actor: 'coder', payload: {},
    });
    await orchestrator.processIntention({
      action: 'complete', task_id: 'T-3000', actor: 'coder',
      payload: { deliverables: ['src/f.ts'], checks_passed: ['pass'], verification_count: 1 },
    });
    await orchestrator.processIntention({
      action: 'review', task_id: 'T-3000', actor: 'reviewer',
      payload: { verdict: 'approve' },
    });

    // Verify task is done
    const roadmap = await orchestrator.getRoadmap();
    expect(roadmap.tasks['T-3000'].state).toBe('done');

    // Try to claim the done task
    const result = await orchestrator.processIntention({
      action: 'claim', task_id: 'T-3000', actor: 'coder', payload: {},
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toContain('done');
  });
});
