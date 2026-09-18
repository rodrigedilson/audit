import { JsonlEventStoreRepository } from './esaa/core/event-store/jsonl-event-store.repository.js';
import { ContractLoaderService } from './esaa/core/contracts/contract-loader.service.js';
import { ESAAOrchestratorService } from './esaa/orchestrator/esaa-orchestrator.service.js';
import { loadConfig, type ESAAConfig } from './config/esaa-config.js';

export interface Runtime {
  config: ESAAConfig;
  eventStore: JsonlEventStoreRepository;
  contractLoader: ContractLoaderService;
  orchestrator: ESAAOrchestratorService;
}

/**
 * Composition root único do processo. Antes deste arquivo, o grafo de dependências
 * só era montado dentro do `beforeEach` dos testes de integração, o que deixava o
 * projeto sem nenhum caminho de execução em produção.
 */
export async function bootstrap(configPath?: string, baseDir?: string): Promise<Runtime> {
  const config = await loadConfig(configPath, baseDir);

  const eventStore = new JsonlEventStoreRepository(config.eventStore.path);
  await eventStore.initialize();

  const contractLoader = new ContractLoaderService();
  await contractLoader.loadAgentContract(config.contracts.agentContract);

  const orchestrator = new ESAAOrchestratorService(eventStore, contractLoader);
  if (config.verification.replayOnStartup) {
    await orchestrator.initialize();
  }

  return { config, eventStore, contractLoader, orchestrator };
}
