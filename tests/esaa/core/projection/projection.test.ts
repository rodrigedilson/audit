import { describe, it, expect } from 'vitest';
import { ProjectorService, EMPTY_PROJECTION_TIMESTAMP } from '../../../../src/esaa/core/projection/projector.service.js';
import { HashVerifierService } from '../../../../src/esaa/core/projection/hash-verifier.service.js';
import type { ESAAEventData } from '../../../../src/esaa/shared/types/esaa-event.types.js';

function createEvent(seq: number, action: string, taskId: string, actor: string, payload: Record<string, unknown>): ESAAEventData {
  return {
    event_id: `evt-${seq}`,
    event_seq: seq,
    action: action as ESAAEventData['action'],
    task_id: taskId,
    actor,
    ts: new Date().toISOString(),
    schema_version: '0.4.0',
    payload: payload as ESAAEventData['payload'],
  };
}

describe('ProjectorService', () => {
  const projector = new ProjectorService();

  it('deve projetar roadmap vazio sem eventos', () => {
    const roadmap = projector.project([]);
    expect(roadmap.run).toBeNull();
    expect(Object.keys(roadmap.tasks)).toHaveLength(0);
    expect(roadmap.stats.total).toBe(0);
  });

  it('deve projetar run.start + task.create', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Feature X', objectives: ['Build X'],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Implement feature', assigned_agent: 'coder', parent_run: 'run-001',
      }),
    ];

    const roadmap = projector.project(events);
    expect(roadmap.run?.run_id).toBe('run-001');
    expect(roadmap.run?.phase_name).toBe('Feature X');
    expect(roadmap.tasks['T-1000']).toBeDefined();
    expect(roadmap.tasks['T-1000'].state).toBe('todo');
    expect(roadmap.stats.total).toBe(1);
    expect(roadmap.stats.todo).toBe(1);
  });

  it('deve projetar ciclo completo: create→claim→complete→review(approve)', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Test', objectives: [],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-001',
      }),
      createEvent(2, 'claim', 'T-1000', 'coder', {}),
      createEvent(3, 'complete', 'T-1000', 'coder', {
        deliverables: ['src/feature.ts'], checks_passed: ['test_pass'], verification_count: 1,
      }),
      createEvent(4, 'review', 'T-1000', 'reviewer', {
        verdict: 'approve', comments: 'LGTM',
      }),
    ];

    const roadmap = projector.project(events);
    expect(roadmap.tasks['T-1000'].state).toBe('done');
    expect(roadmap.stats.done).toBe(1);
    expect(roadmap.stats.todo).toBe(0);
  });

  it('deve projetar review com request_changes voltando para in_progress', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Test', objectives: [],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-001',
      }),
      createEvent(2, 'claim', 'T-1000', 'coder', {}),
      createEvent(3, 'complete', 'T-1000', 'coder', {
        deliverables: ['src/feature.ts'], checks_passed: ['test_pass'], verification_count: 1,
      }),
      createEvent(4, 'review', 'T-1000', 'reviewer', {
        verdict: 'request_changes', comments: 'Missing error handling',
      }),
    ];

    const roadmap = projector.project(events);
    expect(roadmap.tasks['T-1000'].state).toBe('in_progress');
  });

  it('deve contar output.rejected', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'output.rejected', 'T-1000', 'tech-lead', {
        reason: 'boundary_violation', details: 'Cannot write', original_action: 'complete', validation_layer: 5,
      }),
    ];

    const roadmap = projector.project(events);
    expect(roadmap.stats.rejected_count).toBe(1);
  });
});

describe('HashVerifierService', () => {
  const projector = new ProjectorService();
  const verifier = new HashVerifierService(projector);

  it('deve verificar integridade quando projeção bate', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Test', objectives: [],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-001',
      }),
    ];

    const roadmap = projector.project(events);
    const result = verifier.verify(events, roadmap);

    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(2);
  });

  it('deve detectar divergência quando o hash é adulterado', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Test', objectives: [],
      }),
    ];

    const roadmap = projector.project(events);
    roadmap.projection_hash_sha256 = 'hash-adulterado-12345';

    const result = verifier.verify(events, roadmap);
    expect(result.valid).toBe(false);
  });

  /**
   * O caso que importa para INV-006, e que a canonicalização quebrada do ADR-005
   * não pegava: adulterar o *conteúdo* da projeção mantendo o hash gravado. É a
   * forma que um número de apuração seria alterado sem deixar rastro.
   */
  it('deve detectar adulteração do conteúdo da projeção, não só do hash', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Test', objectives: [],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-001',
      }),
      createEvent(2, 'claim', 'T-1000', 'coder', {}),
      createEvent(3, 'complete', 'T-1000', 'coder', {
        deliverables: ['src/a.ts'], checks_passed: ['lint', 'test'], verification_count: 2,
      }),
      createEvent(4, 'review', 'T-1000', 'reviewer', { verdict: 'approve' }),
    ];

    const roadmap = projector.project(events);
    expect(verifier.verify(events, roadmap).valid).toBe(true);

    // Rebaixa a task concluída sem tocar no hash gravado.
    roadmap.tasks['T-1000']!.state = 'todo';
    roadmap.stats.done = 0;
    roadmap.stats.todo = 1;

    const result = verifier.verify(events, roadmap);

    expect(result.valid).toBe(false);
    // O event log está intacto, então o replay ainda bate com o hash gravado; quem
    // denuncia a adulteração é o hash recalculado sobre o conteúdo recebido.
    expect(result.replayHash).toBe(result.storedHash);
    expect(result.contentHash).not.toBe(result.storedHash);
  });

  it('deve detectar perda de evento no log, com a projeção intacta', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Test', objectives: [],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-001',
      }),
    ];

    const roadmap = projector.project(events);
    const result = verifier.verify(events.slice(0, 1), roadmap);

    expect(result.valid).toBe(false);
    // Espelho do caso anterior: aqui o conteúdo é coerente consigo mesmo e é o
    // replay que denuncia o evento faltante.
    expect(result.contentHash).toBe(result.storedHash);
    expect(result.replayHash).not.toBe(result.storedHash);
  });
});

describe('ProjectorService — determinismo (INV-006)', () => {
  const projector = new ProjectorService();

  /**
   * `last_updated` era inicializado com `new Date()`, então o log vazio produzia um
   * hash diferente a cada projeção — e `POST /verify` de um CNPJ com período aberto
   * e nenhum documento sempre acusaria divergência.
   */
  it('projeta log vazio de forma estável entre execuções', () => {
    const first = projector.project([]);
    const second = projector.project([]);

    expect(first.last_updated).toBe(EMPTY_PROJECTION_TIMESTAMP);
    expect(second.projection_hash_sha256).toBe(first.projection_hash_sha256);
  });

  it('projeta log não vazio de forma estável, derivando last_updated do último evento', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Fechamento', objectives: [],
      }),
      createEvent(1, 'task.create', 'T-1000', 'tech-lead', {
        kind: 'impl', description: 'Task', assigned_agent: 'coder', parent_run: 'run-001',
      }),
    ];

    const first = projector.project(events);
    const second = projector.project(events);

    expect(first.projection_hash_sha256).toBe(second.projection_hash_sha256);
    expect(first.last_updated).toBe(events[1]!.ts);
  });

  it('instâncias distintas do projetor concordam no mesmo hash', () => {
    const events: ESAAEventData[] = [
      createEvent(0, 'run.start', 'run-001', 'tech-lead', {
        run_id: 'run-001', phase_name: 'Fechamento', objectives: [],
      }),
    ];

    expect(new ProjectorService().project(events).projection_hash_sha256).toBe(
      new ProjectorService().project(events).projection_hash_sha256,
    );
  });
});
