import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStoreRepository } from '../../src/esaa/core/event-store/jsonl-event-store.repository.js';
import { ContractLoaderService } from '../../src/esaa/core/contracts/contract-loader.service.js';
import { ESAAOrchestratorService } from '../../src/esaa/orchestrator/esaa-orchestrator.service.js';
import { QueenOrchestratorAdapter } from '../../src/esaa/bridge/hive-mind/queen-orchestrator.adapter.js';
import { WorkerAgentAdapter } from '../../src/esaa/bridge/hive-mind/worker-agent.adapter.js';
import { MemoryEventSyncService, type IHiveMindMemory } from '../../src/esaa/bridge/hive-mind/memory-event-sync.service.js';
import { PhaseToRunMapper } from '../../src/esaa/bridge/gsd/phase-to-run.mapper.js';
import { PARCERProfileService } from '../../src/esaa/bridge/agents/parcer-profile.service.js';
import { IntentionFormatterService } from '../../src/esaa/bridge/agents/intention-formatter.service.js';

// Simula a memória compartilhada do Hive Mind
class MockHiveMindMemory implements IHiveMindMemory {
  private data = new Map<string, unknown>();

  async store(key: string, namespace: string, value: unknown): Promise<void> {
    this.data.set(`${namespace}::${key}`, value);
  }

  async retrieve(key: string, namespace: string): Promise<unknown> {
    return this.data.get(`${namespace}::${key}`) ?? null;
  }

  getAll(): Map<string, unknown> {
    return new Map(this.data);
  }
}

function log(step: string, emoji: string, detail: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${emoji}  PASSO: ${step}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(detail);
}

describe('ESAA + Hive Mind + GSD — Demonstração Passo a Passo', () => {
  let tempDir: string;
  let eventStorePath: string;
  let repo: JsonlEventStoreRepository;
  let orchestrator: ESAAOrchestratorService;
  let contractLoader: ContractLoaderService;
  let hiveMindMemory: MockHiveMindMemory;
  let memorySync: MemoryEventSyncService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'esaa-demo-'));
    eventStorePath = join(tempDir, 'activity.jsonl');
    repo = new JsonlEventStoreRepository(eventStorePath);
    await repo.initialize();

    contractLoader = new ContractLoaderService();
    await contractLoader.loadAgentContract(join(process.cwd(), 'config', 'AGENT_CONTRACT.yaml'));

    orchestrator = new ESAAOrchestratorService(repo, contractLoader);
    await orchestrator.initialize();

    hiveMindMemory = new MockHiveMindMemory();
    memorySync = new MemoryEventSyncService(repo, hiveMindMemory);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('Fluxo completo: GSD → Queen decompõe → Workers executam → Reviewer aprova → Verify', async () => {
    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 1: GSD Phase → ESAA Run (mapeamento automático)       ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('1 — GSD Phase Mapping', '📋',
      'O GSD define uma fase com 3 tarefas.\n' +
      'O PhaseToRunMapper converte para intenções ESAA automaticamente.'
    );

    const gsdMapper = new PhaseToRunMapper();
    const intentions = gsdMapper.mapPhaseToIntentions({
      id: 'phase-42',
      name: 'Módulo de Autenticação',
      objectives: [
        'Implementar login com JWT',
        'Criar middleware de autorização',
        'Cobertura de testes > 80%',
      ],
      tasks: [
        { id: '1000', description: 'Especificar API de autenticação', assignee: 'architect' },
        { id: '1001', description: 'Implementar auth service + middleware', assignee: 'coder' },
        { id: '1002', description: 'Testes unitários e de integração do auth', assignee: 'tester' },
      ],
    });

    console.log(`\n  Intenções geradas: ${intentions.length}`);
    for (const i of intentions) {
      console.log(`    → ${i.action} | task_id=${i.task_id} | actor=${i.actor}`);
    }

    expect(intentions).toHaveLength(4); // 1 run.start + 3 task.create

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 2: Queen (tech-lead) processa intenções via ESAA      ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('2 — Queen processa intenções', '👑',
      'A Queen (tech-lead) atua como ESAA Orchestrator.\n' +
      'Cada intenção passa pelo pipeline de 7 camadas antes de ser aceita.'
    );

    const queen = new QueenOrchestratorAdapter(orchestrator);

    for (const intention of intentions) {
      const result = await orchestrator.processIntention(intention);
      const status = result.accepted ? '✅ ACEITA' : '❌ REJEITADA';
      console.log(`    ${status} | ${intention.action} → task_id=${intention.task_id} (seq=${result.event?.event_seq})`);
      expect(result.accepted).toBe(true);
    }

    // Verificar roadmap após decomposição
    let roadmap = await orchestrator.getRoadmap();
    console.log(`\n  📊 Roadmap após decomposição:`);
    console.log(`     Run: ${roadmap.run?.phase_name} (${roadmap.run?.status})`);
    console.log(`     Tasks: ${roadmap.stats.total} total | ${roadmap.stats.todo} todo | ${roadmap.stats.done} done`);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 3: PARCER Profile — governança de metaprompting       ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('3 — Perfis PARCER carregados', '🎯',
      'Cada agente recebe um perfil PARCER que governa seu comportamento.\n' +
      'PARCER = Persona · Audience · Rules · Context · Execution · Response'
    );

    const parcerService = new PARCERProfileService();
    const profiles = ['spec', 'impl', 'qa', 'review'] as const;
    for (const kind of profiles) {
      const profile = parcerService.getProfile(kind);
      console.log(`\n    [${kind.toUpperCase()}] Persona: ${profile.persona}`);
      console.log(`    Rules: ${profile.rules.slice(0, 2).join(' | ')}...`);
    }

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 4: Architect (spec) claim + complete                  ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('4 — Architect faz claim e complete', '📐',
      'O architect é um agente "spec" — só pode escrever em docs/spec/.\n' +
      'Ele faz claim (todo→in_progress) e depois complete (in_progress→review).'
    );

    const architectAdapter = new WorkerAgentAdapter(orchestrator, 'architect');
    const formatter = new IntentionFormatterService();

    // Claim
    const claimResult = await architectAdapter.claimTask('T-1000', 'Iniciar especificação');
    console.log(`    CLAIM: ${claimResult.accepted ? '✅' : '❌'} | T-1000 | todo → in_progress`);
    expect(claimResult.accepted).toBe(true);

    // Complete
    const completeResult = await architectAdapter.completeTask(
      'T-1000',
      ['docs/spec/auth-api.md', 'docs/spec/auth-adr-001.md'],
      ['schema_valid', 'acceptance_criteria_defined', 'adr_documented'],
    );
    console.log(`    COMPLETE: ${completeResult.accepted ? '✅' : '❌'} | T-1000 | in_progress → review`);
    console.log(`    Deliverables: docs/spec/auth-api.md, docs/spec/auth-adr-001.md`);
    console.log(`    Checks: schema_valid, acceptance_criteria_defined, adr_documented`);
    expect(completeResult.accepted).toBe(true);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 5: Boundary violation — architect tenta src/          ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('5 — Teste de boundary violation', '🚫',
      'Simulamos o architect tentando escrever em src/ (proibido para spec).\n' +
      'A Layer 5 (Boundary) do pipeline rejeita a intenção.'
    );

    // Criar outra task spec para testar
    await orchestrator.processIntention({
      action: 'task.create', task_id: 'T-1003', actor: 'tech-lead',
      payload: { kind: 'spec', description: 'Extra spec', assigned_agent: 'architect', parent_run: 'run-phase-42' },
    });
    await orchestrator.processIntention({
      action: 'claim', task_id: 'T-1003', actor: 'architect', payload: {},
    });

    const boundaryViolation = await orchestrator.processIntention({
      action: 'complete',
      task_id: 'T-1003',
      actor: 'architect',
      payload: { deliverables: ['src/hacked.ts'], checks_passed: ['none'], verification_count: 1 },
      file_updates: [{ path: 'src/hacked.ts', content: 'console.log("hacked")' }],
    });

    console.log(`    RESULTADO: ${boundaryViolation.accepted ? '✅ ACEITA' : '❌ REJEITADA'}`);
    console.log(`    Motivo: ${boundaryViolation.rejectionReason}`);
    expect(boundaryViolation.accepted).toBe(false);
    expect(boundaryViolation.rejectionReason).toContain('boundary');

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 6: Reviewer aprova spec do architect                  ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('6 — Reviewer aprova a spec', '✅',
      'O reviewer é um agente "review" — não pode escrever em nenhum path.\n' +
      'Ele apenas emite verdict: approve ou request_changes.'
    );

    const reviewIntention = formatter.formatReview('T-1000', 'reviewer', 'approve', 'Spec completa e bem documentada');
    const reviewResult = await orchestrator.processIntention(reviewIntention);
    console.log(`    REVIEW: ${reviewResult.accepted ? '✅' : '❌'} | T-1000 | review → done (IMUTÁVEL)`);
    expect(reviewResult.accepted).toBe(true);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 7: Coder claim + complete (task impl)                 ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('7 — Coder implementa (task impl)', '💻',
      'O coder é um agente "impl" — pode escrever em src/ e tests/.\n' +
      'Ele faz o ciclo completo: claim → complete.'
    );

    const coderAdapter = new WorkerAgentAdapter(orchestrator, 'coder');

    const coderClaim = await coderAdapter.claimTask('T-1001', 'Iniciar implementação auth');
    console.log(`    CLAIM: ${coderClaim.accepted ? '✅' : '❌'} | T-1001 | todo → in_progress`);

    const coderComplete = await coderAdapter.completeTask(
      'T-1001',
      ['src/auth/auth.service.ts', 'src/auth/jwt.middleware.ts', 'tests/auth/auth.test.ts'],
      ['unit_tests_pass', 'lint_pass', 'no_security_issues', 'coverage_82_percent'],
    );
    console.log(`    COMPLETE: ${coderComplete.accepted ? '✅' : '❌'} | T-1001 | in_progress → review`);
    console.log(`    Deliverables: auth.service.ts, jwt.middleware.ts, auth.test.ts`);
    console.log(`    Checks: unit_tests_pass, lint_pass, no_security_issues, coverage_82%`);

    // Reviewer aprova implementação
    const implReview = await orchestrator.processIntention(
      formatter.formatReview('T-1001', 'reviewer', 'approve', 'Implementação sólida, cobertura adequada'),
    );
    console.log(`    REVIEW: ${implReview.accepted ? '✅' : '❌'} | T-1001 | review → done`);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 8: Tester executa QA                                  ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('8 — Tester executa QA', '🧪',
      'O tester é um agente "qa" — pode escrever em docs/qa/ e tests/.\n' +
      'Não pode modificar src/ — apenas validar e reportar.'
    );

    const testerAdapter = new WorkerAgentAdapter(orchestrator, 'tester');
    const testerClaim = await testerAdapter.claimTask('T-1002', 'Iniciar QA do auth');
    console.log(`    CLAIM: ${testerClaim.accepted ? '✅' : '❌'} | T-1002 | todo → in_progress`);

    const testerComplete = await testerAdapter.completeTask(
      'T-1002',
      ['docs/qa/auth-qa-report.md', 'tests/auth/auth-e2e.test.ts'],
      ['all_acceptance_criteria_met', 'e2e_tests_pass', 'security_scan_clean'],
    );
    console.log(`    COMPLETE: ${testerComplete.accepted ? '✅' : '❌'} | T-1002 | in_progress → review`);

    const qaReview = await orchestrator.processIntention(
      formatter.formatReview('T-1002', 'reviewer', 'approve', 'QA completo, todos os critérios atendidos'),
    );
    console.log(`    REVIEW: ${qaReview.accepted ? '✅' : '❌'} | T-1002 | review → done`);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 9: Imutabilidade — tentativa de reabrir task done     ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('9 — Teste de imutabilidade', '🔒',
      'Tasks no estado "done" são IMUTÁVEIS.\n' +
      'Qualquer tentativa de claim/complete/review é rejeitada.\n' +
      'Correções devem usar o workflow de hotfix (issue.report → hotfix.create).'
    );

    const immutabilityTest = await orchestrator.processIntention({
      action: 'claim', task_id: 'T-1000', actor: 'coder', payload: {},
    });
    console.log(`    CLAIM em task done: ${immutabilityTest.accepted ? '✅ ACEITA' : '❌ REJEITADA'}`);
    console.log(`    Motivo: ${immutabilityTest.rejectionReason}`);
    expect(immutabilityTest.accepted).toBe(false);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 10: Sincronização com Hive Mind Memory                ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('10 — Sync Event Store → Hive Mind Memory', '🧠',
      'O MemoryEventSyncService sincroniza o event store com a memória\n' +
      'compartilhada do Hive Mind (namespace: software-engineering).\n' +
      'Isso permite que todos os agentes vejam o estado atual via MCP memory.'
    );

    const syncResult = await memorySync.sync();
    console.log(`    Eventos sincronizados: ${syncResult.synced}`);

    const hiveMindData = hiveMindMemory.getAll();
    console.log(`    Chaves na memória Hive Mind: ${hiveMindData.size}`);
    for (const [key, value] of hiveMindData) {
      if (key.includes('roadmap-snapshot')) {
        const snapshot = value as Record<string, unknown>;
        console.log(`\n    📊 Snapshot do Roadmap no Hive Mind:`);
        const stats = snapshot.stats as Record<string, number>;
        console.log(`       Total: ${stats.total} | Done: ${stats.done} | Todo: ${stats.todo}`);
        console.log(`       Hash: ${(snapshot.projection_hash as string)?.substring(0, 24)}...`);
      } else if (key.includes('esaa-status')) {
        const status = value as Record<string, unknown>;
        console.log(`    🤖 ${key}: action=${status.last_action} task=${status.task_id}`);
      }
    }

    expect(syncResult.synced).toBeGreaterThan(0);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 11: Verificação de integridade via SHA-256 replay     ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('11 — Verificação SHA-256 (replay determinístico)', '🔐',
      'O orquestrador faz replay completo do event store,\n' +
      're-projeta o roadmap e compara o hash SHA-256.\n' +
      'Se bater = integridade OK. Se divergir = corrupção detectada.'
    );

    const verification = await orchestrator.verify();
    console.log(`    Integridade: ${verification.valid ? '✅ VÁLIDA' : '❌ CORROMPIDA'}`);
    console.log(`    Total de eventos: ${verification.eventCount}`);
    expect(verification.valid).toBe(true);

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 12: Event Store — trail de auditoria completo         ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('12 — Trail de auditoria (activity.jsonl)', '📜',
      'O event store contém TODOS os eventos em ordem cronológica.\n' +
      'Cada linha é um JSON com: event_id, event_seq, action, task_id, actor, ts.\n' +
      'Este log é imutável e permite time-travel debugging.'
    );

    const eventStoreContent = await readFile(eventStorePath, 'utf8');
    const events = eventStoreContent.trim().split('\n').map(line => JSON.parse(line));

    console.log(`\n    Total de eventos no log: ${events.length}`);
    console.log(`    ${'─'.repeat(60)}`);
    for (const event of events) {
      const ts = new Date(event.ts).toISOString().substring(11, 19);
      const actionPad = event.action.padEnd(18);
      const actorPad = event.actor.padEnd(14);
      console.log(`    seq=${event.event_seq.toString().padStart(2)} | ${ts} | ${actionPad} | ${actorPad} | ${event.task_id}`);
    }

    // ╔════════════════════════════════════════════════════════════════╗
    // ║  PASSO 13: Roadmap final (materialized view)                 ║
    // ╚════════════════════════════════════════════════════════════════╝
    log('13 — Roadmap final (materialized view)', '🗺️',
      'O roadmap.json é a projeção determinística do event store.\n' +
      'Mostra o estado atual de todas as tasks, issues e stats.'
    );

    roadmap = await orchestrator.getRoadmap();
    console.log(`\n    Run: "${roadmap.run?.phase_name}" (${roadmap.run?.status})`);
    console.log(`    Objetivos:`);
    for (const obj of roadmap.run?.objectives ?? []) {
      console.log(`      - ${obj}`);
    }
    console.log(`\n    Tasks:`);
    for (const [id, task] of Object.entries(roadmap.tasks)) {
      const stateEmoji = { todo: '⬜', in_progress: '🔄', review: '👀', done: '✅' }[task.state] ?? '❓';
      console.log(`      ${stateEmoji} ${id} [${task.kind}] ${task.description} → ${task.state} (${task.assigned_agent})`);
    }
    console.log(`\n    📊 Stats: total=${roadmap.stats.total} done=${roadmap.stats.done} todo=${roadmap.stats.todo} rejected=${roadmap.stats.rejected_count}`);
    console.log(`    🔐 Hash: ${roadmap.projection_hash_sha256.substring(0, 32)}...`);

    // Asserts finais
    expect(roadmap.tasks['T-1000'].state).toBe('done');
    expect(roadmap.tasks['T-1001'].state).toBe('done');
    expect(roadmap.tasks['T-1002'].state).toBe('done');
    expect(roadmap.stats.done).toBe(3);
    expect(roadmap.stats.rejected_count).toBeGreaterThan(0); // boundary + immutability rejections
  });
});
