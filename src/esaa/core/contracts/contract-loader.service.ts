import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { TaskKind } from '../../shared/types/esaa-vocabulary.js';
import { ContractNotFoundError } from '../../shared/types/esaa-errors.js';
import { TaskBoundary } from '../task-machine/value-objects/task-boundary.vo.js';

export interface AgentBoundaryConfig {
  readable: string[];
  writable: string[];
  forbidden: string[];
}

export interface AgentContractConfig {
  agents: Record<string, {
    task_kind: TaskKind;
    allowed_actions: string[];
    boundaries: AgentBoundaryConfig;
  }>;
}

export interface OrchestratorContractConfig {
  invariants: Record<string, {
    description: string;
    enforcement: string;
  }>;
}

export class ContractLoaderService {
  private agentContracts: AgentContractConfig | null = null;
  private orchestratorContracts: OrchestratorContractConfig | null = null;

  async loadAgentContract(configPath: string): Promise<AgentContractConfig> {
    const content = await readFile(configPath, 'utf8');
    this.agentContracts = parseYaml(content) as AgentContractConfig;
    return this.agentContracts;
  }

  async loadOrchestratorContract(configPath: string): Promise<OrchestratorContractConfig> {
    const content = await readFile(configPath, 'utf8');
    this.orchestratorContracts = parseYaml(content) as OrchestratorContractConfig;
    return this.orchestratorContracts;
  }

  getBoundaryForAgent(agentName: string): TaskBoundary {
    if (!this.agentContracts) {
      throw new Error('Agent contracts not loaded. Call loadAgentContract() first.');
    }

    const config = this.agentContracts.agents[agentName];
    if (!config) {
      throw new ContractNotFoundError(agentName);
    }

    return TaskBoundary.create(
      config.boundaries.readable,
      config.boundaries.writable,
      config.boundaries.forbidden,
    );
  }

  getTaskKindForAgent(agentName: string): TaskKind {
    if (!this.agentContracts) {
      throw new Error('Agent contracts not loaded. Call loadAgentContract() first.');
    }

    const config = this.agentContracts.agents[agentName];
    if (!config) {
      throw new ContractNotFoundError(agentName);
    }

    return config.task_kind;
  }

  getAllowedActions(agentName: string): string[] {
    if (!this.agentContracts) {
      throw new Error('Agent contracts not loaded. Call loadAgentContract() first.');
    }

    const config = this.agentContracts.agents[agentName];
    if (!config) {
      throw new ContractNotFoundError(agentName);
    }

    return config.allowed_actions;
  }

  isLoaded(): boolean {
    return this.agentContracts !== null;
  }
}
