import { describe, it, expect } from 'vitest';
import { ProjectorService } from '../../../../src/esaa/core/projection/projector.service.js';
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

  it('deve detectar divergência quando roadmap é adulterado', () => {
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
});
