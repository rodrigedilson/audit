/**
 * Superfície pública do pacote. O `tsconfig` emite `declaration` e `declarationMap`,
 * então o kernel é consumível como biblioteca — a camada HTTP da Onda 1 e a CLI em
 * `src/cli/audit.ts` são apenas dois clientes deste barril.
 */
export * from './esaa/index.js';
export {
  bootstrap,
  DEV_TENANT_ID,
  DEV_CNPJ,
  type Runtime,
  type BootstrapOptions,
} from './composition-root.js';
export { loadConfig, DEFAULT_CONFIG_PATH, ConfigError, type ESAAConfig } from './config/esaa-config.js';
