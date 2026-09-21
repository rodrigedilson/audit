/**
 * Migra o dado fiscal do `sped-genius-hub` para o event log do `audit`.
 *
 * Os dois produtos dividem o mesmo Postgres, e o front já ingeriu documentos que
 * o `audit` não conhece: eles estão em `xml_documents`, com o XML original na
 * coluna `raw_xml`. Como o `audit` guarda evento e não linha de tabela, a
 * migração **não é `INSERT ... SELECT`** — é reingestão, para que cada documento
 * atravesse as 7 camadas de validação e produza event log com hash verificável.
 * Copiar a linha pronta daria o número sem a trilha que o defende, que é o
 * produto inteiro.
 *
 * Por padrão **simula**: lê, parseia com o parser do próprio `audit` e relata o
 * que aconteceria, sem escrever nada. `--executar` grava.
 *
 *   npx tsx scripts/migrar-do-front.ts                 # simulação
 *   npx tsx scripts/migrar-do-front.ts --executar      # grava no event log
 *   npx tsx scripts/migrar-do-front.ts --regime lucro_real --executar
 */
import pg from 'pg';
import { loadDotEnv } from '../src/config/dotenv.js';
import { parseNfe, DocumentParseError } from '../src/fiscal/ingestion/nfe-parser.js';
import { REGIMES, type Regime } from '../src/fiscal/shared/fiscal-vocabulary.js';

loadDotEnv();

const EXECUTAR = process.argv.includes('--executar');
const REGIME = lerRegime();

interface LinhaDoFront {
  chave_acesso: string | null;
  raw_xml: string;
  cnpj_emitente: string | null;
  cnpj_destinatario: string | null;
}

interface Cadastro {
  cnpj: string;
  legalName: string;
  uf: string | undefined;
}

interface Recusa {
  chave: string;
  camada: number;
  motivo: string;
  detalhe: string;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) {
    erro('DATABASE_URL ausente. O `.env` não foi lido, ou a variável não está lá.');
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });

  try {
    const { rows } = await pool.query<LinhaDoFront>(
      `select chave_acesso, raw_xml, cnpj_emitente, cnpj_destinatario
         from xml_documents
        where raw_xml is not null
        order by data_emissao, chave_acesso`,
    );

    if (rows.length === 0) {
      console.log('Nada a migrar: `xml_documents` não tem linha com `raw_xml`.');
      return;
    }

    console.log(`${rows.length} documento(s) com XML original em xml_documents.\n`);

    const cnpjCliente = inferirCliente(rows);
    const cadastro = await lerCadastro(pool, cnpjCliente);

    console.log(`Cliente: ${cadastro.legalName}`);
    console.log(`CNPJ:    ${cadastro.cnpj}${cadastro.uf === undefined ? '' : `  UF ${cadastro.uf}`}`);
    console.log(`Regime:  ${REGIME}\n`);

    const { aceitos, recusados, competencias, entradas, saidas } = simular(rows, cnpjCliente);

    console.log('--- simulação pelo parser do audit (camadas 1 e 2) ---');
    console.log(`  parseiam:  ${aceitos.length}`);
    console.log(`  recusados: ${recusados.length}`);
    console.log(`  entradas:  ${entradas}   saídas: ${saidas}`);
    console.log(`  competências: ${[...competencias].sort().join(', ')}\n`);

    if (recusados.length > 0) {
      console.log('--- recusas, agrupadas por motivo ---');
      const porMotivo = new Map<string, Recusa[]>();
      for (const r of recusados) {
        const lista = porMotivo.get(r.detalhe) ?? [];
        lista.push(r);
        porMotivo.set(r.detalhe, lista);
      }
      for (const [detalhe, lista] of [...porMotivo].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${String(lista.length).padStart(4)}x camada ${lista[0]!.camada}: ${detalhe}`);
      }
      console.log();
    }

    if (!EXECUTAR) {
      console.log('Simulação. Nada foi gravado.');
      console.log('Para executar de verdade:');
      console.log(`  npx tsx scripts/migrar-do-front.ts --regime ${REGIME} --executar`);
      console.log();
      console.log('O que a execução faz, em ordem:');
      console.log(`  1. cria "${cadastro.legalName}" (${cadastro.cnpj}, ${REGIME}) na carteira`);
      console.log(`  2. abre a(s) competência(s) ${[...competencias].sort().join(', ')}`);
      console.log(`  3. ingere os ${aceitos.length} documentos pela API, um por um`);
      console.log();
      console.log('**Isto é irreversível.** O event log é append-only: uma vez gravado, o');
      console.log('evento não sai. Confira a lista de recusas acima antes.');
      return;
    }

    await executar(pool, cadastro, competencias);
  } finally {
    await pool.end();
  }
}

/**
 * O cliente é o CNPJ que aparece em **todos** os documentos.
 *
 * No `sped-genius-hub` não existe conceito de cliente — só `user_id`. No `audit`
 * o CNPJ é o eixo de tudo (sequência do log, competência, apuração), então ele
 * precisa ser identificado. O CNPJ do escritório aparece como emitente nas
 * saídas e como destinatário nas entradas; qualquer outro aparece só de um lado.
 * Se houver empate, a inferência é abandonada em vez de chutada.
 */
function inferirCliente(rows: readonly LinhaDoFront[]): string {
  const contagem = new Map<string, number>();

  for (const linha of rows) {
    for (const cnpj of [linha.cnpj_emitente, linha.cnpj_destinatario]) {
      if (cnpj !== null && cnpj.length === 14) {
        contagem.set(cnpj, (contagem.get(cnpj) ?? 0) + 1);
      }
    }
  }

  const ordenado = [...contagem].sort((a, b) => b[1] - a[1]);
  const primeiro = ordenado[0];

  if (primeiro === undefined) {
    erro('Nenhum CNPJ de 14 dígitos em xml_documents.');
  }

  if (primeiro[1] < rows.length) {
    erro(
      `O CNPJ mais frequente (${primeiro[0]}) aparece em ${primeiro[1]} de ${rows.length} ` +
        'documentos, e não em todos. A carteira teria mais de um cliente e a escolha não ' +
        'é minha: informe com --cnpj.',
    );
  }

  const informado = valorDeArgumento('--cnpj');
  return informado ?? primeiro[0];
}

function simular(
  rows: readonly LinhaDoFront[],
  cnpjCliente: string,
): {
  aceitos: { chave: string; period: string; entrada: boolean }[];
  recusados: Recusa[];
  competencias: Set<string>;
  entradas: number;
  saidas: number;
} {
  const aceitos: { chave: string; period: string; entrada: boolean }[] = [];
  const recusados: Recusa[] = [];
  const competencias = new Set<string>();
  let entradas = 0;
  let saidas = 0;

  for (const linha of rows) {
    const rotulo = linha.chave_acesso ?? '(sem chave no front)';

    try {
      const parsed = parseNfe(linha.raw_xml);
      const entrada = parsed.issuerCnpj !== cnpjCliente;

      competencias.add(parsed.period);
      aceitos.push({ chave: parsed.accessKey, period: parsed.period, entrada });
      if (entrada) entradas += 1;
      else saidas += 1;
    } catch (causa) {
      const falha =
        causa instanceof DocumentParseError
          ? causa
          : new DocumentParseError('schema_violation', 1, String(causa));

      recusados.push({
        chave: rotulo,
        camada: falha.layer,
        motivo: falha.reason,
        detalhe: falha.message.slice(0, 120),
      });
    }
  }

  return { aceitos, recusados, competencias, entradas, saidas };
}

/**
 * A ingestão real vai pela **API**, não pelo banco.
 *
 * Escrever direto nas tabelas puliria o orquestrador, o advisory lock por CNPJ e
 * as 7 camadas — e produziria event log sem as garantias que o log existe para
 * dar. O script então exige a API no ar e usa as mesmas rotas que o painel usa.
 */
/**
 * Razão social e UF vêm das notas que o próprio cliente emitiu.
 *
 * O dado está ali e é o que ele declarou ao Fisco; cadastrar "Cliente
 * 04552217000165" quando a nota diz o nome seria descartar informação boa por
 * preguiça, e o nome aparece no Book que vai para o cliente final.
 */
async function lerCadastro(pool: pg.Pool, cnpj: string): Promise<Cadastro> {
  const { rows } = await pool.query<{ nome: string | null; uf: string | null }>(
    `select razao_social_emitente as nome, uf_emitente as uf
       from xml_documents
      where cnpj_emitente = $1 and razao_social_emitente is not null
      group by 1, 2 order by count(*) desc limit 1`,
    [cnpj],
  );

  const linha = rows[0];
  return {
    cnpj,
    legalName: linha?.nome ?? `Cliente ${cnpj}`,
    uf: linha?.uf ?? undefined,
  };
}

async function executar(
  pool: pg.Pool,
  cadastro: Cadastro,
  competencias: ReadonlySet<string>,
): Promise<void> {
  const api = process.env['MIGRACAO_API_URL'];
  const token = process.env['MIGRACAO_TOKEN'];

  if (api === undefined || token === undefined) {
    erro(
      'Para executar, a API precisa estar no ar e o script precisa de um token:\n' +
        '  MIGRACAO_API_URL=http://localhost:3000\n' +
        '  MIGRACAO_TOKEN=<access_token de um owner>\n\n' +
        'O token sai de `POST /v1/auth/login`. A ingestão vai pela API de propósito: ' +
        'escrever direto no banco puliria o orquestrador e as 7 camadas, e produziria ' +
        'event log sem as garantias que ele existe para dar.',
    );
  }

  console.log(`--- executando contra ${api} ---`);

  const chamar = async (rota: string, corpo: unknown): Promise<Response> =>
    fetch(`${api.replace(/\/$/, '')}/v1${rota}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });

  const cliente = await chamar('/clients', {
    cnpj: cadastro.cnpj,
    legal_name: cadastro.legalName,
    regime: REGIME,
    ...(cadastro.uf === undefined ? {} : { uf: cadastro.uf }),
  });
  console.log(`  cliente "${cadastro.legalName}": HTTP ${cliente.status}`);

  for (const period of [...competencias].sort()) {
    const r = await chamar(`/clients/${cadastro.cnpj}/periods`, { period });
    console.log(`  competência ${period}: HTTP ${r.status}`);
  }

  const { rows } = await pool.query<{ chave_acesso: string | null; raw_xml: string }>(
    `select chave_acesso, raw_xml from xml_documents
      where raw_xml is not null order by data_emissao, chave_acesso`,
  );

  let aceitos = 0;
  const recusas: string[] = [];

  for (const [i, linha] of rows.entries()) {
    const form = new FormData();
    form.append(
      'files',
      new Blob([linha.raw_xml], { type: 'text/xml' }),
      `${linha.chave_acesso ?? `doc-${i}`}.xml`,
    );

    const r = await fetch(`${api.replace(/\/$/, '')}/v1/clients/${cadastro.cnpj}/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const corpo = (await r.json().catch(() => ({}))) as {
      accepted?: unknown[];
      rejected?: { reason?: string; message?: string; layer?: number }[];
    };

    if ((corpo.accepted ?? []).length > 0) {
      aceitos += 1;
    } else {
      const primeira = corpo.rejected?.[0];
      recusas.push(
        `${linha.chave_acesso ?? `#${i}`}: camada ${primeira?.layer ?? '?'} ${primeira?.reason ?? `HTTP ${r.status}`}`,
      );
    }

    if ((i + 1) % 25 === 0) {
      console.log(`  ${i + 1}/${rows.length} enviados (${aceitos} aceitos)`);
    }
  }

  console.log(`\n--- resultado ---`);
  console.log(`  aceitos:  ${aceitos}`);
  console.log(`  recusados: ${recusas.length}`);
  for (const r of recusas.slice(0, 20)) {
    console.log(`    ${r}`);
  }
  if (recusas.length > 20) {
    console.log(`    … e outras ${recusas.length - 20}`);
  }

  console.log('\nConfira a integridade do log:');
  console.log(`  npx tsx src/cli/audit.ts verify --cnpj ${cadastro.cnpj}`);
}

function lerRegime(): Regime {
  const informado = valorDeArgumento('--regime');

  if (informado === undefined) {
    // Sem padrão: o regime decide alíquota, anexo e a apuração inteira, e
    // assumir um faria a migração produzir número errado em silêncio.
    erro(
      `Informe o regime do cliente com --regime. Opções: ${REGIMES.join(', ')}.\n` +
        'Não há padrão de propósito: o regime decide a apuração inteira, e assumir um ' +
        'faria a migração gravar número errado sem avisar.',
    );
  }

  if (!(REGIMES as readonly string[]).includes(informado)) {
    erro(`Regime '${informado}' não existe. Opções: ${REGIMES.join(', ')}.`);
  }

  return informado as Regime;
}

function valorDeArgumento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
}

function erro(mensagem: string): never {
  console.error(`\n${mensagem}\n`);
  process.exit(2);
}

await main();
