/**
 * Cópia de segurança do acervo legado, antes de qualquer migração.
 *
 * Três comandos, e nenhum escreve no banco:
 *
 * ```
 * # 1. Gera o arquivo cifrado (tabelas, estrutura e buckets) e o confere relendo do disco.
 * read -rs LEGADO_SENHA && export LEGADO_SENHA
 * doppler run --project audit --config prd -- npx tsx scripts/arquivar-legado.ts gerar --saida ~/acervo-legado
 *
 * # 2. Confere um arquivo já gerado: decifra, refaz cada hash e, com --contra-banco,
 * #    compara com o banco de agora.
 * doppler run --project audit --config prd -- npx tsx scripts/arquivar-legado.ts conferir ~/acervo-legado/<arquivo> --contra-banco
 *
 * # 3. Depois da migration do schema `legado`: confere que a cópia no banco é
 * #    idêntica à origem, tabela a tabela.
 * doppler run --project audit --config prd -- npx tsx scripts/arquivar-legado.ts conferir-schema
 * ```
 *
 * A senha fica só com quem guarda o arquivo. Sem ela o arquivo não se abre, e
 * não há como recuperá-la.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';
import { cifrar, decifrar } from '../src/infrastructure/legacy/archive-cipher.js';
import { baixarObjetos } from '../src/infrastructure/legacy/storage-download.js';
import {
  LEGACY_TABLES,
  conferirConteudo,
  linhasDaTabela,
  manifestoDe,
  registrosDoArquivo,
  snapshotLegacy,
  type ArchiveManifest,
} from '../src/infrastructure/legacy/legacy-archive.js';

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
}

function falhar(mensagem: string): never {
  console.error(`\n${mensagem}\n`);
  process.exit(2);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (v === undefined || v === '') falhar(`${nome} não definida.`);
  return v;
}

/**
 * O arquivo é dado fiscal sigiloso: não pode nascer dentro do repositório, onde
 * um `git add -A` o levaria para o GitHub.
 */
function pastaDeSaida(informada: string | undefined): string {
  if (informada === undefined) falhar('Informe a pasta com --saida (fora do repositório).');
  const pasta = resolve(informada.replace(/^~(?=$|\/)/, homedir()));
  const dentro = relative(process.cwd(), pasta);
  if (dentro === '' || (!dentro.startsWith('..') && !isAbsolute(dentro))) {
    falhar(`A pasta ${pasta} está dentro do repositório. Escolha uma fora dele, por exemplo ~/acervo-legado.`);
  }
  return pasta;
}

function pool(): pg.Pool {
  const p = new pg.Pool({
    connectionString: exigir('DATABASE_URL'),
    max: 1,
    connectionTimeoutMillis: 15_000,
  });
  ignorarErroDeClienteOcioso(p, 'AcervoLegadoPool');
  return p;
}

function resumir(m: ArchiveManifest): void {
  console.log(`Instante da cópia: ${m.takenAt} (schema ${m.schema})`);
  for (const t of m.tables)
    console.log(`  ${t.name.padEnd(30)} ${String(t.rowCount).padStart(6)} linha(s)  ${t.sha256.slice(0, 16)}…`);
  for (const v of m.views) console.log(`  ${v.name.padEnd(30)} view, ${v.rowCount} linha(s) (definição guardada)`);
  console.log(`  ${m.functions.length} função(ões) que citam as tabelas`);
  console.log(
    m.storageIncluded
      ? `  ${m.objects.length} objeto(s) do storage, ${m.objects.reduce((s, o) => s + o.bytes, 0)} byte(s)`
      : '  storage NÃO incluído (--sem-storage): os arquivos dos buckets não estão nesta cópia',
  );
}

async function gerar(): Promise<void> {
  const senha = exigir('LEGADO_SENHA');
  const pasta = pastaDeSaida(argumento('--saida'));
  const semStorage = process.argv.includes('--sem-storage');
  const p = pool();
  try {
    const snapshot = await snapshotLegacy(p);
    let objetos = null;
    if (snapshot.storageObjects !== null && !semStorage) {
      objetos = await baixarObjetos(
        snapshot.storageObjects,
        exigir('SUPABASE_URL'),
        exigir('SUPABASE_SERVICE_ROLE_KEY'),
      );
    } else if (snapshot.storageObjects === null) {
      objetos = [];
    }

    const conteudo = registrosDoArquivo(snapshot, objetos);
    await mkdir(pasta, { recursive: true, mode: 0o700 });
    const arquivo = join(pasta, `acervo-legado-${snapshot.takenAt.replace(/[^0-9]/g, '').slice(0, 14)}.audleg`);
    await writeFile(arquivo, cifrar(conteudo, senha), {
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(arquivo, 0o600);

    // Backup que ninguém releu é hipótese: relê do disco, decifra e refaz os hashes.
    const conferencia = conferirConteudo(decifrar(await readFile(arquivo), senha));
    if (conferencia.problems.length > 0) {
      falhar(`O arquivo gravado não confere:\n  ${conferencia.problems.join('\n  ')}`);
    }
    resumir(manifestoDe(snapshot, objetos));
    console.log(`\nGravado e conferido: ${arquivo}`);
    console.log('Guarde o arquivo em dois lugares e a senha num terceiro. Sem a senha ele não se abre.');
  } finally {
    await p.end();
  }
}

async function conferir(): Promise<void> {
  const caminho = process.argv[3];
  if (caminho === undefined || caminho.startsWith('--')) falhar('Informe o arquivo: conferir <arquivo>.');
  const { manifest, problems } = conferirConteudo(decifrar(await readFile(caminho), exigir('LEGADO_SENHA')));
  resumir(manifest);

  if (process.argv.includes('--contra-banco')) {
    const p = pool();
    try {
      for (const t of manifest.tables) {
        const agora = await linhasDaTabela(p, manifest.schema, t.name);
        if (agora.sha256 !== t.sha256) {
          problems.push(
            `${t.name}: o banco de agora difere do arquivo (${agora.rows.length} linha(s) agora, ${t.rowCount} no arquivo).`,
          );
        }
      }
    } finally {
      await p.end();
    }
  }

  if (problems.length > 0) falhar(`Não confere:\n  ${problems.join('\n  ')}`);
  console.log('\nConfere: o arquivo decifra e cada hash bate.');
}

async function conferirSchema(): Promise<void> {
  const p = pool();
  const problemas: string[] = [];
  try {
    for (const t of LEGACY_TABLES) {
      const [origem, copia] = await Promise.all([linhasDaTabela(p, 'public', t), linhasDaTabela(p, 'legado', t)]);
      const ok = origem.sha256 === copia.sha256;
      console.log(
        `  ${t.padEnd(30)} ${String(origem.rows.length).padStart(6)} / ${String(copia.rows.length).padStart(6)}  ${ok ? 'idêntica' : 'DIFERENTE'}`,
      );
      if (!ok) problemas.push(t);
    }
  } finally {
    await p.end();
  }
  if (problemas.length > 0) falhar(`A cópia em legado difere da origem em: ${problemas.join(', ')}.`);
  console.log('\nA cópia no schema legado é idêntica à origem, tabela a tabela.');
}

const comando = process.argv[2];
const acoes: Record<string, () => Promise<void>> = {
  gerar,
  conferir,
  'conferir-schema': conferirSchema,
};
const acao = comando === undefined ? undefined : acoes[comando];
if (acao === undefined)
  falhar('Uso: arquivar-legado.ts gerar --saida <pasta> | conferir <arquivo> [--contra-banco] | conferir-schema');
acao().catch((erro: unknown) => falhar(erro instanceof Error ? erro.message : String(erro)));
