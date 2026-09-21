import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Forma tipada de `config/esaa.config.yaml`. O arquivo existia desde o início e
 * nenhuma linha de código o lia — os caminhos do event store e dos contratos eram
 * passados à mão por cada chamador (na prática, só pelos testes). Carregá-lo aqui
 * torna a configuração viva e dá um único lugar para a Onda 1 acrescentar o
 * adapter Postgres e o escopo de tenant.
 */
export interface ESAAConfig {
  version: string;
  eventStore: { path: string; schemaPath: string };
  materializedView: { path: string; autoProject: boolean };
  contracts: { agentContract: string; orchestratorContract: string };
  runtime: {
    attemptTtlMinutes: number;
    maxAttemptsPerTask: number;
    cooldownMinutes: number;
    singleWriter: boolean;
  };
  verification: { autoVerify: boolean; hashAlgorithm: string; replayOnStartup: boolean };
}

export const DEFAULT_CONFIG_PATH = 'config/esaa.config.yaml';

interface RawConfig {
  esaa?: {
    version?: string;
    event_store?: { path?: string; schema_path?: string };
    materialized_view?: { path?: string; auto_project?: boolean };
    contracts?: { agent_contract?: string; orchestrator_contract?: string };
    runtime?: {
      attempt_ttl_minutes?: number;
      max_attempts_per_task?: number;
      cooldown_minutes?: number;
      single_writer?: boolean;
    };
    verification?: {
      auto_verify?: boolean;
      hash_algorithm?: string;
      replay_on_startup?: boolean;
    };
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Carrega e valida a configuração. Todo caminho é resolvido contra `baseDir`, para
 * que a CLI funcione de qualquer diretório de trabalho — os caminhos do YAML são
 * relativos à raiz do projeto, não ao `cwd`.
 */
export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
  baseDir: string = process.cwd(),
): Promise<ESAAConfig> {
  const absoluteConfigPath = isAbsolute(configPath) ? configPath : resolve(baseDir, configPath);

  let raw: RawConfig;
  try {
    raw = parseYaml(await readFile(absoluteConfigPath, 'utf8')) as RawConfig;
  } catch (cause) {
    throw new ConfigError(
      `Não foi possível ler a configuração em '${absoluteConfigPath}': ${describe(cause)}`,
    );
  }

  const esaa = raw?.esaa;
  if (!esaa) {
    throw new ConfigError(`Configuração inválida em '${absoluteConfigPath}': falta a chave 'esaa'`);
  }

  const inBase = (value: string | undefined, key: string): string => {
    if (!value) {
      throw new ConfigError(`Configuração inválida: falta '${key}'`);
    }
    return isAbsolute(value) ? value : resolve(baseDir, value);
  };

  return {
    version: esaa.version ?? '0.4.0',
    eventStore: {
      path: inBase(esaa.event_store?.path, 'esaa.event_store.path'),
      schemaPath: inBase(esaa.event_store?.schema_path, 'esaa.event_store.schema_path'),
    },
    materializedView: {
      path: inBase(esaa.materialized_view?.path, 'esaa.materialized_view.path'),
      autoProject: esaa.materialized_view?.auto_project ?? true,
    },
    contracts: {
      agentContract: inBase(esaa.contracts?.agent_contract, 'esaa.contracts.agent_contract'),
      orchestratorContract: inBase(
        esaa.contracts?.orchestrator_contract,
        'esaa.contracts.orchestrator_contract',
      ),
    },
    runtime: {
      attemptTtlMinutes: esaa.runtime?.attempt_ttl_minutes ?? 30,
      maxAttemptsPerTask: esaa.runtime?.max_attempts_per_task ?? 3,
      cooldownMinutes: esaa.runtime?.cooldown_minutes ?? 2,
      singleWriter: esaa.runtime?.single_writer ?? true,
    },
    verification: {
      autoVerify: esaa.verification?.auto_verify ?? true,
      hashAlgorithm: esaa.verification?.hash_algorithm ?? 'sha256',
      replayOnStartup: esaa.verification?.replay_on_startup ?? true,
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
