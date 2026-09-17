import { describe, it, expect } from 'vitest';
import { TaskStateVO } from '../../../../src/esaa/core/task-machine/value-objects/task-state.vo.js';
import { TaskBoundary } from '../../../../src/esaa/core/task-machine/value-objects/task-boundary.vo.js';
import { StateTransitionService } from '../../../../src/esaa/core/task-machine/state-transition.service.js';
import { ImmutabilityGuardService } from '../../../../src/esaa/core/task-machine/immutability-guard.service.js';
import type { MaterializedTask } from '../../../../src/esaa/shared/types/esaa-event.types.js';

describe('TaskStateVO', () => {
  it('deve criar estado todo', () => {
    const state = TaskStateVO.todo();
    expect(state.isTodo()).toBe(true);
    expect(state.toString()).toBe('todo');
  });

  it('deve permitir transição todo → in_progress', () => {
    const state = TaskStateVO.todo();
    expect(state.canTransitionTo('in_progress')).toBe(true);
  });

  it('deve rejeitar transição todo → done', () => {
    const state = TaskStateVO.todo();
    expect(state.canTransitionTo('done')).toBe(false);
  });

  it('deve rejeitar transição done → qualquer', () => {
    const state = TaskStateVO.create('done');
    expect(state.canTransitionTo('todo')).toBe(false);
    expect(state.canTransitionTo('in_progress')).toBe(false);
    expect(state.canTransitionTo('review')).toBe(false);
  });

  it('deve lançar erro em transição inválida via transitionTo', () => {
    const state = TaskStateVO.todo();
    expect(() => state.transitionTo('done', 'T-1000')).toThrow('Invalid transition');
  });
});

describe('TaskBoundary', () => {
  it('deve permitir escrita em paths autorizados', () => {
    const boundary = TaskBoundary.create(
      ['.roadmap/', 'docs/'],
      ['docs/spec/'],
      ['src/', 'tests/'],
    );

    expect(boundary.canWrite('docs/spec/feature.md')).toBe(true);
  });

  it('deve rejeitar escrita em paths proibidos', () => {
    const boundary = TaskBoundary.create(
      ['.roadmap/', 'docs/'],
      ['docs/spec/'],
      ['src/', 'tests/'],
    );

    expect(boundary.canWrite('src/feature.ts')).toBe(false);
  });

  it('deve rejeitar escrita em paths não autorizados', () => {
    const boundary = TaskBoundary.create(
      ['.roadmap/'],
      ['docs/spec/'],
      ['src/'],
    );

    expect(boundary.canWrite('config/settings.yaml')).toBe(false);
  });

  it('deve lançar erro no assertCanWrite para path proibido', () => {
    const boundary = TaskBoundary.create([], ['docs/'], ['src/']);
    expect(() => boundary.assertCanWrite('src/main.ts', 'architect')).toThrow('cannot write');
  });
});

describe('StateTransitionService', () => {
  const service = new StateTransitionService();

  it('deve resolver claim: todo → in_progress', () => {
    const result = service.resolveTransition('claim', 'todo', 'T-1000');
    expect(result).toBe('in_progress');
  });

  it('deve resolver complete: in_progress → review', () => {
    const result = service.resolveTransition('complete', 'in_progress', 'T-1000');
    expect(result).toBe('review');
  });

  it('deve resolver review approve: review → done', () => {
    const result = service.resolveTransition('review', 'review', 'T-1000', 'approve');
    expect(result).toBe('done');
  });

  it('deve resolver review request_changes: review → in_progress', () => {
    const result = service.resolveTransition('review', 'review', 'T-1000', 'request_changes');
    expect(result).toBe('in_progress');
  });

  it('deve rejeitar transição inválida', () => {
    expect(() => service.resolveTransition('claim', 'done', 'T-1000')).toThrow();
  });
});

describe('ImmutabilityGuardService', () => {
  const guard = new ImmutabilityGuardService();

  const doneTask: MaterializedTask = {
    task_id: 'T-1000',
    kind: 'impl',
    description: 'Done task',
    state: 'done',
    assigned_agent: 'coder',
    parent_run: 'run-001',
    dependencies: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deliverables: [],
    checks_passed: [],
    is_hotfix: false,
  };

  it('deve lançar erro ao tentar claim em task done', () => {
    expect(() => guard.guard(doneTask, 'claim')).toThrow('done');
  });

  it('deve lançar erro ao tentar complete em task done', () => {
    expect(() => guard.guard(doneTask, 'complete')).toThrow('done');
  });

  it('deve permitir issue.report em task done', () => {
    expect(() => guard.guard(doneTask, 'issue.report')).not.toThrow();
  });
});
