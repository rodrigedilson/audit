/**
 * Carrega a tabela oficial de NCM em `fiscal_codes`.
 *
 * Fonte: **Portal Único Siscomex**, endpoint público e sem autenticação:
 * `https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json`
 *
 * O arquivo traz a nomenclatura inteira com vigência por código e o ato
 * normativo que criou cada um (`Tipo_Ato_Ini`, `Numero_Ato_Ini`, `Ano_Ato_Ini`)
 * — que vai para a procedência da linha. Quem audita a validação pergunta de
 * onde saiu o código, não de onde saiu a tabela.
 *
 * **Só os códigos de 8 dígitos entram.** A nomenclatura é hierárquica e tem
 * níveis de 2, 4, 5, 6 e 7 dígitos, que são capítulos e posições — não são NCM
 * de item e não aparecem em documento fiscal. Carregá-los faria a camada 3
 * aceitar `01` como NCM válido.
 *
 * **A descrição é reconstruída pela hierarquia.** No arquivo, a descrição de um
 * código é só o seu nível: `0101.21.00` é `"-- Reprodutores de raça pura"`, o
 * que não diz nada sozinho. Concatenando os ancestrais sai `"Animais vivos ·
 * Cavalos, asininos e muares · Cavalos · Reprodutores de raça pura"`. Não é
 * invenção: é o que a própria Receita publica como "XLSX com descrição
 * concatenada", reconstruído a partir da mesma fonte.
 *
 * Idempotente por `on conflict`. Insere em lotes porque são ~10.500 linhas, e
 * uma por `INSERT` levaria minutos — o mesmo motivo do lote na apuração.
 *
 * ```
 * npx tsx scripts/carregar-ncm-oficial.ts
 * npx tsx scripts/carregar-ncm-oficial.ts --executar
 * npx tsx scripts/carregar-ncm-oficial.ts --arquivo ncm.json --executar
 * ```
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

const ENDPOINT =
  'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json';

/** Níveis da nomenclatura, em dígitos. Só o último é NCM de item. */
const NIVEIS = [2, 4, 5, 6, 7, 8] as const;

/** Linhas por `INSERT`. 5 parâmetros × 400 = 2.000, longe do teto de 65.535. */
const LOTE = 400;

interface Nomenclatura {
  Codigo: string;
  Descricao: string;
  Data_Inicio: string;
  Data_Fim: string;
  Tipo_Ato_Ini?: string;
  Numero_Ato_Ini?: string;
  Ano_Ato_Ini?: string;
}

interface Arquivo {
  Data_Ultima_Atualizacao_NCM?: string;
  Ato?: string;
  Nomenclaturas: Nomenclatura[];
}

/** `01/04/2022` → `2022-04-01`. `31/12/9999` é "sem fim" e vira nulo. */
function data(valor: string | undefined): string | null {
  if (valor === undefined || valor === '') {
    return null;
  }
  if (valor.startsWith('31/12/9999')) {
    return null;
  }
  const [dia, mes, ano] = valor.split('/');
  return dia && mes && ano ? `${ano}-${mes}-${dia}` : null;
}

function digitos(codigo: string): string {
  return codigo.replace(/\D/g, '');
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const indice = process.argv.indexOf('--arquivo');
  const caminho = indice === -1 ? null : process.argv[indice + 1];

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  let arquivo: Arquivo;
  if (caminho !== null && caminho !== undefined) {
    arquivo = JSON.parse(await readFile(caminho, 'utf8')) as Arquivo;
    console.log(`Fonte: ${caminho}`);
  } else {
    console.log(`Fonte: ${ENDPOINT}`);
    const resposta = await fetch(ENDPOINT);
    if (!resposta.ok) {
      throw new Error(`O Siscomex respondeu ${resposta.status}.`);
    }
    arquivo = (await resposta.json()) as Arquivo;
  }

  console.log(
    `Tabela ${arquivo.Data_Ultima_Atualizacao_NCM ?? '(sem data)'}` +
      `${arquivo.Ato === undefined ? '' : ` · ${arquivo.Ato}`}`,
  );

  const porCodigo = new Map<string, Nomenclatura>();
  for (const n of arquivo.Nomenclaturas) {
    porCodigo.set(digitos(n.Codigo), n);
  }

  /** Descrição do código mais a dos seus ancestrais, do capítulo ao item. */
  const descricaoCompleta = (codigo: string): string => {
    const partes: string[] = [];
    for (const nivel of NIVEIS) {
      if (nivel > codigo.length) {
        break;
      }
      const ancestral = porCodigo.get(codigo.slice(0, nivel));
      if (ancestral !== undefined) {
        // O arquivo prefixa os níveis com `-` e `--` para indicar profundidade;
        // dentro de uma descrição concatenada eles viram ruído.
        const limpa = ancestral.Descricao.replace(/^[-\s.]+/, '').trim();
        if (limpa !== '' && !partes.includes(limpa)) {
          partes.push(limpa);
        }
      }
    }
    return partes.join(' · ');
  };

  const itens = arquivo.Nomenclaturas.filter((n) => digitos(n.Codigo).length === 8);
  console.log(
    `\n${arquivo.Nomenclaturas.length} entradas na nomenclatura, ` +
      `${itens.length} com 8 dígitos (NCM de item).`,
  );

  const encerradas = itens.filter((n) => data(n.Data_Fim) !== null).length;
  console.log(`${encerradas} com vigência encerrada — entram com valid_to.`);

  if (!executar) {
    console.log('\nSimulação. Amostra:');
    for (const n of itens.slice(0, 3)) {
      const c = digitos(n.Codigo);
      console.log(`  ${c} · ${descricaoCompleta(c).slice(0, 90)}`);
    }
    console.log('\nUse --executar para carregar.');
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 60_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaNcmPool');

  const client = await pool.connect();
  try {
    await client.query('begin');

    for (let i = 0; i < itens.length; i += LOTE) {
      const lote = itens.slice(i, i + LOTE);
      const valores: unknown[] = [];
      const grupos: string[] = [];

      lote.forEach((n, j) => {
        const c = digitos(n.Codigo);
        const ato =
          n.Tipo_Ato_Ini === undefined || n.Tipo_Ato_Ini === ''
            ? 'Portal Único Siscomex'
            : `${n.Tipo_Ato_Ini} ${n.Numero_Ato_Ini ?? ''}/${n.Ano_Ato_Ini ?? ''}`.trim();

        const base = j * 5;
        grupos.push(
          `('ncm', $${base + 1}, $${base + 2}, coalesce($${base + 3}::date, '2022-01-01'), ` +
            `$${base + 4}::date, $${base + 5})`,
        );
        valores.push(c, descricaoCompleta(c), data(n.Data_Inicio), data(n.Data_Fim), ato);
      });

      await client.query(
        `insert into fiscal_codes (kind, code, description, valid_from, valid_to, source)
         values ${grupos.join(', ')}
         on conflict (kind, code, valid_from) do update set
           description = excluded.description,
           valid_to = excluded.valid_to,
           source = excluded.source`,
        valores,
      );

      if ((i / LOTE) % 5 === 0) {
        process.stdout.write(`\r  ${Math.min(i + LOTE, itens.length)} de ${itens.length}…`);
      }
    }

    await client.query('commit');
    process.stdout.write('\r');
  } catch (causa) {
    await client.query('rollback').catch(() => undefined);
    throw causa;
  } finally {
    client.release();
  }

  const { rows } = await pool.query<{ kind: string; n: string }>(
    `select kind, count(*)::text as n from fiscal_codes group by kind order by kind`,
  );
  console.log('\nDepois da carga:');
  for (const linha of rows) {
    console.log(`  ${linha.kind.padEnd(16)} ${linha.n}`);
  }

  await pool.end().catch(() => undefined);
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
