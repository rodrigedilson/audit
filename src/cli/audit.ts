#!/usr/bin/env node
import { loadDotEnv } from '../config/dotenv.js';
import { bootstrap, DEV_TENANT_ID, DEV_CNPJ, type BootstrapOptions } from '../composition-root.js';
import { EventScope } from '../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../esaa/orchestrator/fiscal-orchestrator.service.js';
import { loadEnv, EnvError } from '../config/env.js';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../infrastructure/persistence/pool-errors.js';
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
let ESTRITO = false;

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
  --strict                        verify falha (3) se não houver o que verificar
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
  ESTRITO = rest.includes('--strict');

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command ? EXIT_OK : EXIT_USAGE;
  }

  const options = await readBootstrapOptions(rest);

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

async function readBootstrapOptions(args: readonly string[]): Promise<BootstrapOptions> {
  const configPath = readOption(args, '--config');
  const informadoTenant = readOption(args, '--tenant');
  const informadoCnpj = readOption(args, '--cnpj');

  const cnpj = informadoCnpj ?? DEV_CNPJ;
  const tenant = informadoTenant ?? (await resolverTenant(cnpj));

  const options: BootstrapOptions = { scope: EventScope.create(tenant, cnpj) };
  if (configPath !== undefined) {
    options.configPath = configPath;
  }
  return options;
}

/**
 * Descobre o escritório dono do CNPJ, quando `--tenant` não foi informado.
 *
 * Antes o padrão era o tenant de dev, e quem rodava `verify --cnpj <real>`
 * examinava um escopo que **nunca** teria dado — a saída dizia "0 eventos" e a
 * pessoa concluía que a ingestão falhou, quando o que falhou foi a pergunta.
 * Aconteceu de verdade, com o CNPJ certo e o tenant zerado.
 *
 * Com mais de um escritório para o mesmo CNPJ a escolha não é do programa: ele
 * lista e para. Sem banco alcançável, volta ao padrão de dev, porque `version`
 * e `help` não precisam de banco para funcionar.
 */
async function resolverTenant(cnpj: string): Promise<string> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || cnpj === DEV_CNPJ) {
    return DEV_TENANT_ID;
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 8000 });
  ignorarErroDeClienteOcioso(pool, 'CliPool');

  try {
    const { rows } = await pool.query<{ tenant_id: string; name: string }>(
      `select c.tenant_id, t.name
         from clients c join tenants t on t.id = c.tenant_id
        where c.cnpj = $1::char(14)`,
      [cnpj],
    );

    if (rows.length === 1) {
      return rows[0]!.tenant_id;
    }

    if (rows.length > 1) {
      process.stderr.write(
        `O CNPJ ${cnpj} está em ${rows.length} escritórios. Informe qual com --tenant:\n` +
          rows.map((r) => `  --tenant ${r.tenant_id}   ${r.name}\n`).join(''),
      );
      process.exit(EXIT_USAGE);
    }

    process.stderr.write(
      `O CNPJ ${cnpj} não está na carteira de nenhum escritório deste banco.\n` +
        '  Sem cliente cadastrado não há event log para verificar — cadastre-o\n' +
        '  primeiro, ou confira se o DATABASE_URL aponta para o ambiente certo.\n',
    );
    process.exit(EXIT_USAGE);
  } catch (causa) {
    // Banco fora do ar não impede `version` nem `help`; o comando que precisa
    // dele falha adiante, com a mensagem do próprio bootstrap.
    void causa;
    return DEV_TENANT_ID;
  } finally {
    await pool.end().catch(() => undefined);
  }
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
  const { orchestrator, scope, backend, pool } = await bootstrap(options);

  try {
    const report = await orchestrator.verify();
    return relatarVerificacao(report, scope, backend);
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

function relatarVerificacao(
  report: Awaited<ReturnType<FiscalOrchestratorService['verify']>>,
  scope: EventScope,
  backend: 'postgres' | 'jsonl',
): number {
  process.stdout.write(
    [
      `escopo            ${scope.toKey()}`,
      // De onde o log veio. Sem isto, verificar o arquivo de desenvolvimento e
      // verificar o log do cliente têm a mesma cara na tela.
      `origem do log     ${backend === 'postgres' ? 'Postgres (DATABASE_URL)' : 'arquivo JSONL local'}`,
      `eventos           ${report.eventCount}`,
      `ultimo event_seq  ${report.lastEventSeq}`,
      `hash gravado      ${report.storedHash || '(vazio)'}`,
      `hash do replay    ${report.replayedHash}`,
      `hash do conteudo  ${report.contentHash}`,
      '',
    ].join('\n'),
  );

  /**
   * Log vazio não é log verificado.
   *
   * A projeção vazia bate consigo mesma em qualquer replay, então `valid` vem
   * `true` e a mensagem de sucesso aparece — sobre nada. Quem roda o `verify`
   * depois de uma ingestão lê "OK" e conclui que os documentos entraram, quando
   * o que aconteceu foi o contrário. O `event_seq -1` estava na tela e dizia
   * isso, mas só para quem sabe que -1 é "nenhum evento".
   *
   * Mesma regra do resto do produto: ausência de erro não é verificação. Ver
   * `not_verified` no catálogo, `not_applicable` nas trilhas e
   * `nao_verificavel` no dossiê.
   */
  if (report.eventCount === 0) {
    process.stdout.write(
      'NADA A VERIFICAR — este CNPJ não tem evento no log.\n' +
        '  A projeção vazia fecha consigo mesma, e isso não diz nada sobre os\n' +
        '  documentos: se você esperava que uma ingestão tivesse rodado, ela não\n' +
        '  gravou. Confira o escopo acima — tenant e CNPJ precisam ser os certos.\n',
    );

    /**
     * `--strict` existe para automação.
     *
     * Num pipeline, sair 0 aqui transforma o passo num carimbo: ele passa
     * sempre, inclusive quando não verificou nada, e a equipe conclui que
     * INV-006 está guardado. Interativamente o 0 é correto — não achar evento
     * não é erro de quem perguntou.
     */
    return ESTRITO ? EXIT_INTEGRITY : EXIT_OK;
  }

  if (report.valid) {
    process.stdout.write(
      `OK — a projeção fecha com o event log (${report.eventCount} eventos).\n`,
    );
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
