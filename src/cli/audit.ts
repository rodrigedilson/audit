#!/usr/bin/env node
import { bootstrap } from '../composition-root.js';
import { IntegrityViolationError } from '../esaa/shared/types/esaa-errors.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
/** Código próprio para integridade: deixa a CI distinguir falha de trilha de falha comum. */
const EXIT_INTEGRITY = 3;

const USAGE = `audit — motor de conciliação da transição tributária (ESAA-Flow)

Uso: audit <comando> [opções]

Comandos disponíveis
  verify                          Reprojeta o event log e confere o hash (INV-006)
  status                          Resumo da projeção corrente
  help                            Esta ajuda
  version                         Versão do pacote e do schema de eventos

Comandos previstos (ainda não implementados)
  serve                           Sobe a API de docs/api/openapi.yaml       [Onda 1]
  ingest <cnpj>                   Coleta DF-e e ingere documentos           [Onda 4]
  close <cnpj> <competencia>      Fecha a competência de um CNPJ            [Onda 6]

Opções
  --config <caminho>              Padrão: config/esaa.config.yaml
`;

interface PendingCommand {
  wave: string;
  reason: string;
}

const PENDING: Record<string, PendingCommand> = {
  serve: {
    wave: 'Onda 1',
    reason:
      'a camada HTTP depende do store multi-tenant em Postgres e da autenticação; ' +
      'o contrato já está em docs/api/openapi.yaml',
  },
  ingest: {
    wave: 'Onda 4',
    reason: 'depende do bounded context ingestion/ e do cofre de certificados A1 (Onda 2)',
  },
  close: {
    wave: 'Onda 6',
    reason: 'depende do motor de regras rules/ e da apuração dual assessment/',
  },
};

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command ? EXIT_OK : EXIT_USAGE;
  }

  const configPath = readOption(rest, '--config');

  switch (command) {
    case 'version':
    case '--version':
      return runVersion(configPath);
    case 'verify':
      return runVerify(configPath);
    case 'status':
      return runStatus(configPath);
    default:
      return reportUnavailable(command);
  }
}

async function runVersion(configPath?: string): Promise<number> {
  const { config } = await bootstrap(configPath);
  process.stdout.write(`audit — schema de eventos ${config.version}\n`);
  return EXIT_OK;
}

async function runVerify(configPath?: string): Promise<number> {
  const { orchestrator } = await bootstrap(configPath);
  const report = await orchestrator.verify();

  process.stdout.write(
    [
      `eventos           ${report.eventCount}`,
      `ultimo event_seq  ${report.lastEventSeq}`,
      `hash gravado      ${report.storedHash || '(vazio)'}`,
      `hash do replay    ${report.replayedHash}`,
      `hash do conteudo  ${report.contentHash}`,
      '',
    ].join('\n'),
  );

  if (report.valid) {
    process.stdout.write('OK — a projeção fecha com o event log.\n');
    return EXIT_OK;
  }

  process.stderr.write(
    'FALHA DE INTEGRIDADE — a projeção não deriva do event log.\n' +
      (report.contentHash !== report.storedHash
        ? '  A view materializada foi alterada por fora do log.\n'
        : '') +
      (report.replayedHash !== report.storedHash
        ? '  O event log perdeu, ganhou ou teve eventos alterados.\n'
        : ''),
  );
  return EXIT_INTEGRITY;
}

async function runStatus(configPath?: string): Promise<number> {
  const { orchestrator } = await bootstrap(configPath);
  const roadmap = await orchestrator.getRoadmap();
  const { stats } = roadmap;

  process.stdout.write(
    [
      `run               ${roadmap.run ? `${roadmap.run.run_id} (${roadmap.run.status})` : '(nenhum)'}`,
      `ultimo event_seq  ${roadmap.last_event_seq}`,
      `tasks             ${stats.total} (todo ${stats.todo} · andamento ${stats.in_progress} · review ${stats.review} · done ${stats.done})`,
      `rejeicoes         ${stats.rejected_count}`,
      `issues abertas    ${roadmap.issues.filter((i) => i.status === 'open').length}`,
      `hash              ${roadmap.projection_hash_sha256}`,
      '',
    ].join('\n'),
  );
  return EXIT_OK;
}

function reportUnavailable(command: string): number {
  const pending = PENDING[command];

  if (pending) {
    process.stderr.write(
      `'${command}' ainda não foi implementado — previsto para a ${pending.wave}.\n` +
        `Motivo: ${pending.reason}.\n`,
    );
    return EXIT_ERROR;
  }

  process.stderr.write(`Comando desconhecido: '${command}'.\n\n${USAGE}`);
  return EXIT_USAGE;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new UsageError(`A opção ${name} exige um valor.`);
  }
  return value;
}

class UsageError extends Error {}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      process.exit(EXIT_USAGE);
    }
    if (error instanceof IntegrityViolationError) {
      process.stderr.write(`FALHA DE INTEGRIDADE: ${error.message}\n`);
      process.exit(EXIT_INTEGRITY);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_ERROR);
  });
