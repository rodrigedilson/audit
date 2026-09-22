import pg from 'pg';
import { JsonlEventStoreRepository } from './esaa/core/event-store/jsonl-event-store.repository.js';
import { PostgresEventStoreRepository } from './infrastructure/persistence/postgres-event-store.repository.js';
import type { IEventStoreRepository } from './esaa/core/event-store/event-store.repository.js';
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
  /** Sobrepõe `DATABASE_URL`. Sem os dois, o log vem do arquivo JSONL. */
  databaseUrl?: string;
  configPath?: string;
  baseDir?: string;
  scope?: EventScope;
}

export interface Runtime {
  config: ESAAConfig;
  scope: EventScope;
  eventStore: IEventStoreRepository;
  /** De onde o log foi lido. A CLI imprime isto: ver o comentário de `bootstrap`. */
  backend: 'postgres' | 'jsonl';
  contractLoader: ContractLoaderService;
  orchestrator: FiscalOrchestratorService;
  /** Só com `backend: 'postgres'`; quem abre, fecha. */
  pool?: pg.Pool;
}

/**
 * Composition root do processo.
 *
 * **Escolhe o adapter pelo ambiente, e isso já foi um defeito.** Antes montava
 * sempre o JSONL, que é arquivo local de desenvolvimento. O efeito: `audit
 * verify --cnpj <real>` imprimia o escopo do cliente, três hashes e "OK" — sem
 * nunca ter tocado o Postgres onde o log do cliente está. A ferramenta que
 * existe para provar INV-006 verificava outra coisa, e dizia que estava tudo
 * certo.
 *
 * Com `DATABASE_URL` definida, o log vem do Postgres. Sem ela, do JSONL — que
 * continua sendo o caminho do CI e do desenvolvimento, e é legítimo desde que o
 * comando diga de onde leu.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Runtime> {
  const config = await loadConfig(options.configPath, options.baseDir);
  const scope = options.scope ?? EventScope.create(DEV_TENANT_ID, DEV_CNPJ);

  const connectionString = options.databaseUrl ?? process.env['DATABASE_URL'];

  const contractLoader = new ContractLoaderService();
  await contractLoader.loadAgentContract(config.contracts.agentContract);

  let eventStore: IEventStoreRepository;
  let backend: Runtime['backend'];
  let pool: pg.Pool | undefined;

  if (connectionString !== undefined && connectionString.trim().length > 0) {
    pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 15_000 });
    eventStore = new PostgresEventStoreRepository(pool, scope);
    backend = 'postgres';
  } else {
    const jsonl = new JsonlEventStoreRepository(config.eventStore.path);
    await jsonl.initialize();
    eventStore = jsonl;
    backend = 'jsonl';
  }

  const orchestrator = new FiscalOrchestratorService(eventStore, contractLoader, scope);
  if (config.verification.replayOnStartup) {
    await orchestrator.initialize();
  }

  return {
    config,
    scope,
    eventStore,
    backend,
    contractLoader,
    orchestrator,
    ...(pool === undefined ? {} : { pool }),
  };
}
