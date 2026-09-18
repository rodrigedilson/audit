import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  loadConfig,
  ConfigError,
  DEFAULT_CONFIG_PATH,
} from '../../src/config/esaa-config.js';
import { bootstrap } from '../../src/composition-root.js';

describe('loadConfig', () => {
  it('lê o config real do projeto e resolve os caminhos como absolutos', async () => {
    const config = await loadConfig(DEFAULT_CONFIG_PATH, process.cwd());

    expect(config.version).toBe('0.4.0');
    expect(isAbsolute(config.eventStore.path)).toBe(true);
    expect(isAbsolute(config.contracts.agentContract)).toBe(true);
    expect(config.eventStore.path).toMatch(/\.roadmap[/\\]activity\.jsonl$/);
    expect(config.runtime.singleWriter).toBe(true);
    expect(config.verification.hashAlgorithm).toBe('sha256');
  });

  describe('com um diretório temporário', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'esaa-config-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true });
    });

    /**
     * A CLI é invocada de qualquer diretório; os caminhos do YAML são relativos à
     * raiz do projeto, não ao cwd. Resolver contra `baseDir` é o que evita um event
     * store criado no lugar errado.
     */
    it('resolve caminhos relativos contra baseDir, não contra o cwd', async () => {
      const configPath = join(dir, 'esaa.config.yaml');
      await writeFile(
        configPath,
        [
          'esaa:',
          '  version: "9.9.9"',
          '  event_store:',
          '    path: "logs/eventos.jsonl"',
          '    schema_path: "schemas/evento.json"',
          '  materialized_view:',
          '    path: "logs/view.json"',
          '    auto_project: false',
          '  contracts:',
          '    agent_contract: "config/AGENT_CONTRACT.yaml"',
          '    orchestrator_contract: "config/ORCHESTRATOR_CONTRACT.yaml"',
          '',
        ].join('\n'),
        'utf8',
      );

      const config = await loadConfig(configPath, dir);

      expect(config.version).toBe('9.9.9');
      expect(config.eventStore.path).toBe(join(dir, 'logs/eventos.jsonl'));
      expect(config.materializedView.autoProject).toBe(false);
      // Ausentes no YAML: caem nos defaults declarados.
      expect(config.runtime.maxAttemptsPerTask).toBe(3);
      expect(config.verification.replayOnStartup).toBe(true);
    });

    it('falha com ConfigError quando o arquivo não existe', async () => {
      await expect(loadConfig(join(dir, 'ausente.yaml'), dir)).rejects.toThrow(ConfigError);
    });

    it('falha com ConfigError quando falta a chave esaa', async () => {
      const configPath = join(dir, 'vazio.yaml');
      await writeFile(configPath, 'outra_coisa: 1\n', 'utf8');

      await expect(loadConfig(configPath, dir)).rejects.toThrow(/falta a chave 'esaa'/);
    });

    it('falha com ConfigError quando falta um caminho obrigatório', async () => {
      const configPath = join(dir, 'incompleto.yaml');
      await writeFile(configPath, 'esaa:\n  version: "0.4.0"\n', 'utf8');

      await expect(loadConfig(configPath, dir)).rejects.toThrow(/event_store\.path/);
    });
  });
});

describe('bootstrap', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'esaa-boot-'));
    await mkdir(join(dir, 'config'), { recursive: true });
    await mkdir(join(dir, '.roadmap'), { recursive: true });
    await cp(join(process.cwd(), 'config', 'AGENT_CONTRACT.yaml'), join(dir, 'config', 'AGENT_CONTRACT.yaml'));
    await cp(join(process.cwd(), 'config', 'ORCHESTRATOR_CONTRACT.yaml'), join(dir, 'config', 'ORCHESTRATOR_CONTRACT.yaml'));
    await cp(join(process.cwd(), 'config', 'esaa.config.yaml'), join(dir, 'config', 'esaa.config.yaml'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('monta o grafo de dependências e projeta um log vazio de forma determinística', async () => {
    const runtime = await bootstrap(DEFAULT_CONFIG_PATH, dir);

    const roadmap = await runtime.orchestrator.getRoadmap();
    expect(roadmap.last_event_seq).toBe(-1);

    const report = await runtime.orchestrator.verify();
    expect(report.valid).toBe(true);
    expect(report.eventCount).toBe(0);
  });

  it('o orquestrador montado aceita uma intenção válida', async () => {
    const runtime = await bootstrap(DEFAULT_CONFIG_PATH, dir);

    const result = await runtime.orchestrator.processIntention({
      action: 'run.start',
      task_id: 'run-001',
      actor: 'tech-lead',
      payload: { run_id: 'run-001', phase_name: 'Fechamento', objectives: [] },
    });

    expect(result.accepted).toBe(true);
    await expect(runtime.orchestrator.verify()).resolves.toMatchObject({ valid: true, eventCount: 1 });
  });
});
