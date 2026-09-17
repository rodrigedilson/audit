import { AggregateRoot } from '../../shared/domain/aggregate-root.js';
import { ImmutabilityViolationError } from '../../shared/types/esaa-errors.js';
import type { TaskKind, TaskState } from '../../shared/types/esaa-vocabulary.js';
import { TaskStateVO } from './value-objects/task-state.vo.js';
import { TaskKindVO } from './value-objects/task-kind.vo.js';
import { TaskBoundary } from './value-objects/task-boundary.vo.js';

interface ESAATaskProps {
  taskId: string;
  kind: TaskKindVO;
  description: string;
  state: TaskStateVO;
  assignedAgent: string;
  parentRun: string;
  boundary: TaskBoundary;
  isHotfix: boolean;
  issueId?: string;
  scopePatch?: string[];
}

export class ESAATask extends AggregateRoot<string> {
  private props: ESAATaskProps;

  private constructor(props: ESAATaskProps) {
    super(props.taskId);
    this.props = props;
  }

  static create(
    taskId: string,
    kind: TaskKind,
    description: string,
    assignedAgent: string,
    parentRun: string,
    boundary: TaskBoundary,
  ): ESAATask {
    return new ESAATask({
      taskId,
      kind: TaskKindVO.create(kind),
      description,
      state: TaskStateVO.todo(),
      assignedAgent,
      parentRun,
      boundary,
      isHotfix: false,
    });
  }

  static createHotfix(
    taskId: string,
    assignedAgent: string,
    parentRun: string,
    boundary: TaskBoundary,
    issueId: string,
    scopePatch: string[],
  ): ESAATask {
    return new ESAATask({
      taskId,
      kind: TaskKindVO.create('hotfix'),
      description: `Hotfix for issue ${issueId}`,
      state: TaskStateVO.todo(),
      assignedAgent,
      parentRun,
      boundary,
      isHotfix: true,
      issueId,
      scopePatch,
    });
  }

  claim(): void {
    this.guardImmutability();
    this.props.state = this.props.state.transitionTo('in_progress', this.props.taskId);
  }

  complete(): void {
    this.guardImmutability();
    this.props.state = this.props.state.transitionTo('review', this.props.taskId);
  }

  approve(): void {
    this.guardImmutability();
    this.props.state = this.props.state.transitionTo('done', this.props.taskId);
  }

  requestChanges(): void {
    this.guardImmutability();
    this.props.state = this.props.state.transitionTo('in_progress', this.props.taskId);
  }

  assertCanWrite(path: string): void {
    this.props.boundary.assertCanWrite(path, this.props.assignedAgent);
  }

  getState(): TaskState {
    return this.props.state.toString() as TaskState;
  }

  getKind(): TaskKind {
    return this.props.kind.toString() as TaskKind;
  }

  getAssignedAgent(): string {
    return this.props.assignedAgent;
  }

  getBoundary(): TaskBoundary {
    return this.props.boundary;
  }

  isDone(): boolean {
    return this.props.state.isDone();
  }

  isHotfix(): boolean {
    return this.props.isHotfix;
  }

  private guardImmutability(): void {
    if (this.props.state.isDone()) {
      throw new ImmutabilityViolationError(this.props.taskId);
    }
  }
}
