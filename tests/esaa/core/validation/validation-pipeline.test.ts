import { describe, it, expect } from 'vitest';
import { JsonParseValidator } from '../../../../src/esaa/core/validation/validators/json-parse.validator.js';
import { SchemaValidator } from '../../../../src/esaa/core/validation/validators/schema.validator.js';
import { VocabularyValidator } from '../../../../src/esaa/core/validation/validators/vocabulary.validator.js';
import { ImmutabilityValidator } from '../../../../src/esaa/core/validation/validators/immutability.validator.js';
import type { ESAAIntention, MaterializedRoadmap } from '../../../../src/esaa/shared/types/esaa-event.types.js';

function createEmptyRoadmap(): MaterializedRoadmap {
  return {
    schema_version: '0.4.0',
    projection_hash_sha256: '',
    last_event_seq: -1,
    last_updated: new Date().toISOString(),
    run: null,
    tasks: {},
    issues: [],
    stats: { total: 0, todo: 0, in_progress: 0, review: 0, done: 0, rejected_count: 0 },
  };
}

describe('Layer 1: JsonParseValidator', () => {
  const validator = new JsonParseValidator();

  it('deve rejeitar null', () => {
    expect(() => validator.validate(null)).toThrow();
  });

  it('deve rejeitar objeto sem campos obrigatórios', () => {
    expect(() => validator.validate({ action: 'claim' })).toThrow('Missing required fields');
  });

  it('deve aceitar objeto com todos os campos', () => {
    expect(() => validator.validate({
      action: 'claim', task_id: 'T-1', actor: 'coder', payload: {},
    })).not.toThrow();
  });
});

describe('Layer 2: SchemaValidator', () => {
  const validator = new SchemaValidator();

  it('deve rejeitar action vazio', () => {
    const intention: ESAAIntention = { action: '' as never, task_id: 'T-1', actor: 'coder', payload: {} };
    expect(() => validator.validate(intention)).toThrow('non-empty string');
  });

  it('deve rejeitar payload null', () => {
    const intention = { action: 'claim', task_id: 'T-1', actor: 'coder', payload: null } as unknown as ESAAIntention;
    expect(() => validator.validate(intention)).toThrow('non-null object');
  });
});

describe('Layer 3: VocabularyValidator', () => {
  const validator = new VocabularyValidator();

  it('deve rejeitar action desconhecida', () => {
    const intention: ESAAIntention = { action: 'fly.away' as never, task_id: 'T-1', actor: 'coder', payload: {} };
    expect(() => validator.validate(intention)).toThrow('Unknown action');
  });

  it('deve rejeitar agente emitindo ação de orquestrador', () => {
    const intention: ESAAIntention = { action: 'task.create', task_id: 'T-1', actor: 'coder', payload: {} };
    expect(() => validator.validate(intention)).toThrow('cannot emit orchestrator action');
  });

  it('deve aceitar agente emitindo ação permitida', () => {
    const intention: ESAAIntention = { action: 'claim', task_id: 'T-1', actor: 'coder', payload: {} };
    expect(() => validator.validate(intention)).not.toThrow();
  });

  it('deve aceitar tech-lead emitindo ação de orquestrador', () => {
    const intention: ESAAIntention = { action: 'task.create', task_id: 'T-1', actor: 'tech-lead', payload: {} };
    expect(() => validator.validate(intention)).not.toThrow();
  });
});

describe('Layer 6: ImmutabilityValidator', () => {
  const validator = new ImmutabilityValidator();

  it('deve rejeitar claim em task done', () => {
    const roadmap = createEmptyRoadmap();
    roadmap.tasks['T-1'] = {
      task_id: 'T-1', kind: 'impl', description: 'Done', state: 'done',
      assigned_agent: 'coder', parent_run: 'run-1', dependencies: [],
      created_at: '', updated_at: '', deliverables: [], checks_passed: [], is_hotfix: false,
    };

    const intention: ESAAIntention = { action: 'claim', task_id: 'T-1', actor: 'coder', payload: {} };
    expect(() => validator.validate(intention, roadmap)).toThrow('done');
  });

  it('deve aceitar issue.report em task done', () => {
    const roadmap = createEmptyRoadmap();
    roadmap.tasks['T-1'] = {
      task_id: 'T-1', kind: 'impl', description: 'Done', state: 'done',
      assigned_agent: 'coder', parent_run: 'run-1', dependencies: [],
      created_at: '', updated_at: '', deliverables: [], checks_passed: [], is_hotfix: false,
    };

    const intention: ESAAIntention = { action: 'issue.report', task_id: 'T-1', actor: 'coder', payload: {} };
    expect(() => validator.validate(intention, roadmap)).not.toThrow();
  });
});
