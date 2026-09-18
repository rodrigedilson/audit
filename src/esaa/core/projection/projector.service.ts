import type {
  ESAAEventData,
  MaterializedRoadmap,
  MaterializedTask,
  ESAAIssue,
  TaskCreatePayload,
  CompletePayload,
  ReviewPayload,
  IssueReportPayload,
  HotfixCreatePayload,
  RunStartPayload,
  PhaseCompletePayload,
} from '../../shared/types/esaa-event.types.js';
import type { TaskState } from '../../shared/types/esaa-vocabulary.js';
import { hashProjection } from '../../shared/infrastructure/crypto-utils.js';

class ProjectionError extends Error {
  constructor(action: never, eventSeq: number) {
    super(
      `Projeção interrompida: ação desconhecida '${String(action)}' ` +
        `no evento seq ${eventSeq}`,
    );
    this.name = 'ProjectionError';
  }
}

/**
 * `last_updated` de um log sem eventos. Precisa ser uma constante: usar
 * `new Date()` fazia duas projeções do mesmo log vazio renderem hashes diferentes,
 * quebrando o replay determinístico (INV-006) justamente no caso de um CNPJ com
 * período aberto e nenhum documento ingerido. Fica um ISO válido, em vez de string
 * vazia, para não estourar em quem faça `new Date(last_updated)`; o marcador real
 * de "nada projetado ainda" é `last_event_seq: -1`.
 */
export const EMPTY_PROJECTION_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export class ProjectorService {
  project(events: ESAAEventData[]): MaterializedRoadmap {
    const roadmap: MaterializedRoadmap = {
      schema_version: '0.4.0',
      projection_hash_sha256: '',
      last_event_seq: -1,
      last_updated: EMPTY_PROJECTION_TIMESTAMP,
      run: null,
      tasks: {},
      issues: [],
      stats: { total: 0, todo: 0, in_progress: 0, review: 0, done: 0, rejected_count: 0 },
    };

    for (const event of events) {
      this.applyEvent(roadmap, event);
      roadmap.last_event_seq = event.event_seq;
      roadmap.last_updated = event.ts;
    }

    this.recalculateStats(roadmap);

    const { projection_hash_sha256: _, ...dataToHash } = roadmap;
    roadmap.projection_hash_sha256 = hashProjection(dataToHash);

    return roadmap;
  }

  private applyEvent(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    switch (event.action) {
      case 'run.start':
        this.applyRunStart(roadmap, event);
        break;
      case 'task.create':
        this.applyTaskCreate(roadmap, event);
        break;
      case 'claim':
        this.applyClaim(roadmap, event);
        break;
      case 'complete':
        this.applyComplete(roadmap, event);
        break;
      case 'review':
        this.applyReview(roadmap, event);
        break;
      case 'issue.report':
        this.applyIssueReport(roadmap, event);
        break;
      case 'hotfix.create':
        this.applyHotfixCreate(roadmap, event);
        break;
      case 'output.rejected':
        roadmap.stats.rejected_count++;
        break;
      case 'phase.complete':
        this.applyPhaseComplete(roadmap, event);
        break;

      // Registradas no log como trilha, sem efeito sobre o estado projetado: a
      // verificação é sobre a projeção, e a escrita de arquivo é efeito externo.
      // Ficam explícitas porque antes caíam num fall-through silencioso, que é
      // indistinguível de um handler esquecido.
      case 'verify.start':
      case 'verify.ok':
      case 'verify.fail':
      case 'orchestrator.file.write':
        break;

      default:
        // Exaustividade verificada em tempo de compilação: uma ação nova no
        // vocabulário sem handler aqui quebra o build. Em runtime, um log com ação
        // desconhecida precisa falhar alto — descartá-la em silêncio produziria uma
        // projeção que omite um evento, e o hash atestaria esse número incompleto.
        throw new ProjectionError(event.action, event.event_seq);
    }
  }

  private applyRunStart(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as RunStartPayload;
    roadmap.run = {
      run_id: payload.run_id,
      phase_name: payload.phase_name,
      status: 'active',
      objectives: payload.objectives,
      started_at: event.ts,
    };
  }

  private applyTaskCreate(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as TaskCreatePayload;
    const task: MaterializedTask = {
      task_id: event.task_id,
      kind: payload.kind,
      description: payload.description,
      state: 'todo',
      assigned_agent: payload.assigned_agent,
      parent_run: payload.parent_run,
      dependencies: payload.dependencies ?? [],
      created_at: event.ts,
      updated_at: event.ts,
      deliverables: [],
      checks_passed: [],
      is_hotfix: false,
    };
    roadmap.tasks[event.task_id] = task;
  }

  private applyClaim(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const task = roadmap.tasks[event.task_id];
    if (task) {
      task.state = 'in_progress';
      task.claimed_at = event.ts;
      task.updated_at = event.ts;
    }
  }

  private applyComplete(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as CompletePayload;
    const task = roadmap.tasks[event.task_id];
    if (task) {
      task.state = 'review';
      task.completed_at = event.ts;
      task.updated_at = event.ts;
      task.deliverables = payload.deliverables;
      task.checks_passed = payload.checks_passed;
    }
  }

  private applyReview(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as ReviewPayload;
    const task = roadmap.tasks[event.task_id];
    if (task) {
      if (payload.verdict === 'approve') {
        task.state = 'done';
        task.reviewed_at = event.ts;
      } else {
        task.state = 'in_progress';
      }
      task.updated_at = event.ts;
    }
  }

  private applyIssueReport(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as IssueReportPayload;
    const issue: ESAAIssue = {
      issue_id: event.event_id ?? `issue-${roadmap.issues.length}`,
      severity: payload.severity,
      description: payload.description,
      evidence: payload.evidence,
      affected_tasks: payload.affected_tasks,
      status: 'open',
      created_at: event.ts,
    };
    roadmap.issues.push(issue);
  }

  private applyHotfixCreate(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as HotfixCreatePayload;
    const task: MaterializedTask = {
      task_id: event.task_id,
      kind: 'hotfix',
      description: `Hotfix for issue ${payload.issue_id}`,
      state: 'todo',
      assigned_agent: event.actor,
      parent_run: roadmap.run?.run_id ?? '',
      dependencies: [],
      created_at: event.ts,
      updated_at: event.ts,
      deliverables: [],
      checks_passed: [],
      is_hotfix: true,
      issue_id: payload.issue_id,
      scope_patch: payload.scope_patch,
    };
    roadmap.tasks[event.task_id] = task;

    const issue = roadmap.issues.find((i) => i.issue_id === payload.issue_id);
    if (issue) {
      issue.hotfix_task_id = event.task_id;
    }
  }

  private applyPhaseComplete(roadmap: MaterializedRoadmap, event: ESAAEventData): void {
    const payload = event.payload as PhaseCompletePayload;
    if (roadmap.run && payload.verification_status === 'ok') {
      roadmap.run.status = 'completed';
    }
  }

  private recalculateStats(roadmap: MaterializedRoadmap): void {
    const tasks = Object.values(roadmap.tasks);
    const stateCounts: Record<TaskState, number> = { todo: 0, in_progress: 0, review: 0, done: 0 };

    for (const task of tasks) {
      stateCounts[task.state]++;
    }

    roadmap.stats.total = tasks.length;
    roadmap.stats.todo = stateCounts.todo;
    roadmap.stats.in_progress = stateCounts.in_progress;
    roadmap.stats.review = stateCounts.review;
    roadmap.stats.done = stateCounts.done;
  }
}
