import { JsonlEventStoreRepository } from './esaa/core/event-store/jsonl-event-store.repository.js';
import { EventScope } from './esaa/core/event-store/value-objects/event-scope.vo.js';
import { ContractLoaderService } from './esaa/core/contracts/contract-loader.service.js';
import { FiscalOrchestratorService } from './esaa/orchestrator/fiscal-orchestrator.service.js';
import { loadConfig, type ESAAConfig } from './config/esaa-config.js';

/**
 * Escopo usado pela CLI local quando nenhum tenant é informado. É um sentinela
 * explícito, e não um default silencioso: um UUID de zeros e um CNPJ de zeros são
 * imediatamente reconhecíveis como "log de desenvolvimento" num dump de banco, ao
 * contrário de um tenant plausível.
 */
export const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const DEV_CNPJ = '00000000000000';

export interface BootstrapOptions {
  configPath?: string;
  baseDir?: string;
  scope?: EventScope;
}

export interface Runtime {
  config: ESAAConfig;
  scope: EventScope;
  eventStore: JsonlEventStoreRepository;
  contractLoader: ContractLoaderService;
  orchestrator: FiscalOrchestratorService;
}

/**
 * Composition root do processo. Antes deste arquivo, o grafo de dependências só
 * era montado dentro do `beforeEach` dos testes de integração.
 *
 * Monta o adapter JSONL, que é o caminho de desenvolvimento e de teste. A API
 * multi-tenant monta `PostgresEventStoreRepository` sobre a mesma porta
 * `IEventStoreRepository`, um orquestrador por escopo de requisição.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Runtime> {
  const config = await loadConfig(options.configPath, options.baseDir);
  const scope = options.scope ?? EventScope.create(DEV_TENANT_ID, DEV_CNPJ);

  const eventStore = new JsonlEventStoreRepository(config.eventStore.path);
  await eventStore.initialize();

  const contractLoader = new ContractLoaderService();
  await contractLoader.loadAgentContract(config.contracts.agentContract);

  const orchestrator = new FiscalOrchestratorService(eventStore, contractLoader, scope);
  if (config.verification.replayOnStartup) {
    await orchestrator.initialize();
  }

  return { config, scope, eventStore, contractLoader, orchestrator };
}
