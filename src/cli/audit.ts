#!/usr/bin/env node
import { loadDotEnv } from '../config/dotenv.js';
import { bootstrap, DEV_TENANT_ID, DEV_CNPJ, type BootstrapOptions } from '../composition-root.js';
import { EventScope } from '../esaa/core/event-store/value-objects/event-scope.vo.js';
import { loadEnv, EnvError } from '../config/env.js';
import { buildServer } from '../api/server.js';
import { diagnosticar, type Checagem } from '../infrastructure/diagnostics/environment-doctor.js';
import { IntegrityViolationError } from '../esaa/shared/types/esaa-errors.js';

/**
 * Carrega o `.env` antes de qualquer coisa.
 *
 * Fica só na CLI, e não numa biblioteca: quem importa o kernel como pacote não
 * deve ter o ambiente alterado por efeito colateral de import. O ambiente real
 * tem precedência sobre o arquivo.
 */
const DOTENV = loadDotEnv();

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
/** Código próprio para integridade: deixa a CI distinguir falha de trilha de falha comum. */
const EXIT_INTEGRITY = 3;

const USAGE = `audit — motor de conciliação da transição tributária (ESAA-Flow)

Uso: audit <comando> [opções]

Comandos disponíveis
  doctor                          Diagnostica o ambiente e diz o que falta
  serve                           Sobe a API HTTP (docs/api/openapi.yaml)
  verify                          Reprojeta o event log e confere o hash (INV-006)
  status                          Resumo da projeção corrente
  help                            Esta ajuda
  version                         Versão do pacote e do schema de eventos

Comandos previstos (ainda não implementados)
  ingest <cnpj>                   Coleta DF-e e ingere documentos           [Onda 4]
  close <cnpj> <competencia>      Fecha a competência de um CNPJ            [Onda 6]

Opções
  --config <caminho>              Padrão: config/esaa.config.yaml
  --tenant <uuid>                 Escritório (tenant). Padrão: escopo de dev
  --cnpj <14 dígitos>             CNPJ do cliente. Padrão: escopo de dev
`;

interface PendingCommand {
  wave: string;
  reason: string;
}

const PENDING: Record<string, PendingCommand> = {
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

  const options = readBootstrapOptions(rest);

  switch (command) {
    case 'version':
    case '--version':
      return runVersion(options);
    case 'verify':
      return runVerify(options);
    case 'status':
      return runStatus(options);
    case 'serve':
      return runServe();
    case 'doctor':
      return runDoctor();
    default:
      return reportUnavailable(command);
  }
}

function readBootstrapOptions(args: readonly string[]): BootstrapOptions {
  const configPath = readOption(args, '--config');
  const tenant = readOption(args, '--tenant') ?? DEV_TENANT_ID;
  const cnpj = readOption(args, '--cnpj') ?? DEV_CNPJ;

  const options: BootstrapOptions = { scope: EventScope.create(tenant, cnpj) };
  if (configPath !== undefined) {
    options.configPath = configPath;
  }
  return options;
}

/**
 * Diagnóstico do ambiente. Cada checagem que falha vem com a ação, porque a
 * causa raiz aqui raramente é óbvia a partir do sintoma: schema aplicado pela
 * metade devolve 200 com lista vazia, e falta de `memberships` devolve 403 em
 * tudo.
 */
async function runDoctor(): Promise<number> {
  // Dizer de onde a configuração veio evita o mal-entendido de editar o .env e
  // não entender por que nada mudou.
  process.stdout.write(
    DOTENV.found
      ? `[ ok ] .env\n    ${DOTENV.loaded.length} variáveis carregadas` +
          (DOTENV.skipped.length > 0
            ? `, ${DOTENV.skipped.length} ignoradas porque já estavam no ambiente\n`
            : '\n')
      : '[aviso] .env\n    arquivo não encontrado: a configuração tem de vir do ambiente\n',
  );

  const { checagens, ok } = await diagnosticar();

  for (const checagem of checagens) {
    process.stdout.write(`${simbolo(checagem)} ${checagem.nome}\n`);
    process.stdout.write(`    ${checagem.detalhe}\n`);
    if (checagem.acao !== undefined) {
      process.stdout.write(`    -> ${checagem.acao}\n`);
    }
  }

  process.stdout.write('\n');
  if (ok) {
    process.stdout.write('Ambiente pronto. `npm run dev` sobe a API.\n');
    return EXIT_OK;
  }

  const falhas = checagens.filter((c) => c.estado === 'falha').length;
  process.stdout.write(
    `${falhas} ${falhas === 1 ? 'problema' : 'problemas'} a resolver. ` +
      'Detalhes em docs/setup/SUPABASE.md.\n',
  );
  return EXIT_ERROR;
}

function simbolo(checagem: Checagem): string {
  if (checagem.estado === 'ok') return '[ ok ]';
  return checagem.estado === 'aviso' ? '[aviso]' : '[FALHA]';
}

/**
 * Sobe a API. Não usa `bootstrap`: este monta o adapter JSONL de escopo único, e
 * a API monta um `PostgresEventStoreRepository` por escopo de requisição.
 */
async function runServe(): Promise<number> {
  const env = loadEnv();
  const app = await buildServer({ env });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(EXIT_OK));
    });
  }

  await app.listen({ port: env.port, host: env.host });
  // `listen` resolve e o processo segue vivo; o await acima nunca "termina".
  return EXIT_OK;
}

async function runVersion(options: BootstrapOptions): Promise<number> {
  const { config, scope } = await bootstrap(options);
  process.stdout.write(`audit — schema de eventos ${config.version}\n`);
  process.stdout.write(`escopo: ${scope.toKey()}\n`);
  return EXIT_OK;
}

async function runVerify(options: BootstrapOptions): Promise<number> {
  const { orchestrator, scope } = await bootstrap(options);
  const report = await orchestrator.verify();

  process.stdout.write(
    [
      `escopo            ${scope.toKey()}`,
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

async function runStatus(options: BootstrapOptions): Promise<number> {
  const { orchestrator, scope } = await bootstrap(options);
  const projection = await orchestrator.getProjection();
  const { stats, client } = projection;

  process.stdout.write(
    [
      `escopo            ${scope.toKey()}`,
      `cliente           ${client ? `${client.legal_name} (${client.regime})` : '(nao cadastrado)'}`,
      `ultimo event_seq  ${projection.last_event_seq}`,
      `competencias      ${stats.periods_total} (aberta ${stats.periods_open} · apurada ${stats.periods_assessed} · conciliada ${stats.periods_reconciled} · confirmada ${stats.periods_confirmed})`,
      `documentos        ${stats.documents_received}`,
      `certificado       ${projection.certificate ? `${projection.certificate.serial} (usos: ${projection.certificate.usage_count})` : '(nenhum)'}`,
      `rejeicoes         ${stats.rejected_count}`,
      `issues abertas    ${stats.open_issues}`,
      `hash              ${projection.projection_hash_sha256}`,
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
  .then((code) => {
    // `serve` fica escutando: encerrar o processo aqui mataria o servidor.
    if (code === EXIT_OK && process.argv[2] === 'serve') {
      return;
    }
    process.exit(code);
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      process.exit(EXIT_USAGE);
    }
    if (error instanceof EnvError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT_USAGE);
    }
    if (error instanceof IntegrityViolationError) {
      process.stderr.write(`FALHA DE INTEGRIDADE: ${error.message}\n`);
      process.exit(EXIT_INTEGRITY);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_ERROR);
  });
