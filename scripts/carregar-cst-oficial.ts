/**
 * Carrega CST-ICMS (com CSOSN) e CST-PIS/Cofins em `fiscal_codes`.
 *
 * Fonte: o **XSD oficial da NF-e**, servido pelo portal DF-e da SVRS:
 * `https://dfe-portal.svrs.rs.gov.br/Schemas/PRNFE/leiauteNFe_v4.00.xsd`
 *
 * A escolha do XSD em vez da tabela em PDF é deliberada. As tabelas de CST
 * vivem em textos normativos — Anexos I e III-A do Convênio SINIEF s/n de 1970
 * para o ICMS e o CSOSN, tabelas 4.3.3 e 4.3.4 do SPED para PIS e Cofins — e
 * nenhum dos dois portais publica versão legível por máquina. O XSD, por outro
 * lado, **é o que o autorizador da SEFAZ exige**: um CST que não está na
 * enumeração é rejeitado na autorização. Para um validador, essa é a fonte mais
 * forte que existe, e não um substituto de segunda classe.
 *
 * A separação por tributo vem da **estrutura** do schema, não do texto da
 * documentação:
 *
 * - CST e CSOSN precedidos de `orig` são do ICMS — todo grupo de ICMS na NF-e
 *   começa por `orig` e depois traz `CST` ou `CSOSN`.
 * - CST dentro de `PISAliq`, `PISQtde`, `PISNT`, `PISOutr` e os equivalentes de
 *   COFINS são de PIS/Cofins. As duas tabelas são a mesma lista, e o nosso
 *   schema tem um tipo só (`cst_pis_cofins`).
 * - `IPITrib` e `IPINT` são de IPI, que não tem tipo em `fiscal_codes` — ficam
 *   de fora em vez de serem forçados num tipo que não é o deles.
 *
 * Classificar pelo texto da documentação foi tentado e **contaminou**: alguns
 * blocos não dizem de qual tributo são, e códigos de PIS acabaram contados como
 * ICMS. A estrutura não tem essa ambiguidade.
 *
 * A descrição sai da `xs:documentation` do bloco, que enumera vários códigos num
 * texto só. É extraída por código, e **fica nula quando não casa** — descrição
 * errada num código é pior que descrição ausente, porque a tela a exibiria como
 * se fosse a oficial.
 *
 * ```
 * npx tsx scripts/carregar-cst-oficial.ts
 * npx tsx scripts/carregar-cst-oficial.ts --executar
 * ```
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

const XSD = 'https://dfe-portal.svrs.rs.gov.br/Schemas/PRNFE/leiauteNFe_v4.00.xsd';

/**
 * Vigência da carga.
 *
 * O leiaute 4.00 da NF-e está em produção desde 2018, e os códigos que ele
 * enumera são anteriores a ele. Datar a carga com hoje faria classificação
 * antiga parecer ter usado código inexistente; `2018-01-01` é conservador e
 * anterior a qualquer competência que este sistema apura.
 */
const VIGENTE_DESDE = '2018-01-01';
const FONTE = 'Enumeração do XSD oficial da NF-e (leiauteNFe_v4.00) · Portal DF-e SVRS';

interface Codigo {
  kind: 'cst_icms' | 'cst_pis_cofins';
  code: string;
  description: string | null;
}

/**
 * Extrai pares "código – descrição" do texto da documentação.
 *
 * O separador varia entre `-`, `–` e `=` no próprio arquivo oficial, e vários
 * códigos dividem um mesmo parágrafo. A busca para no próximo código ou no `;`.
 */
function descricoesDo(texto: string): Map<string, string> {
  const limpo = texto
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  const achados = new Map<string, string>();
  const padrao = /(?<![\d.])(\d{2,3})\s*[-–=]\s*([^;]+?)(?=(?:\s+\d{2,3}\s*[-–=])|;|$)/g;

  for (const m of limpo.matchAll(padrao)) {
    const codigo = m[1]!;
    const descricao = m[2]!.trim().replace(/[.\s]+$/, '');
    if (!achados.has(codigo) && descricao.length > 3) {
      achados.set(codigo, descricao);
    }
  }

  return achados;
}

function extrair(xsd: string): Codigo[] {
  /** Nome do último tipo declarado antes de cada posição. */
  const declaracoes = [...xsd.matchAll(/<xs:(?:complexType|element) name="([A-Za-z0-9_]+)"/g)]
    .map((m) => ({ pos: m.index ?? 0, nome: m[1]! }))
    .filter((d) => d.nome !== 'CST' && d.nome !== 'CSOSN');

  const codigos = new Map<string, Codigo>();

  for (const bloco of xsd.matchAll(
    /<xs:element name="(CST|CSOSN)"[^>]*>([\s\S]*?)<\/xs:element>/g,
  )) {
    const posicao = bloco.index ?? 0;
    const corpo = bloco[2]!;

    const anteriores = declaracoes.filter((d) => d.pos < posicao);
    const pai = anteriores.length === 0 ? '' : anteriores[anteriores.length - 1]!.nome;

    let kind: Codigo['kind'] | null = null;
    if (pai === 'orig') {
      kind = 'cst_icms';
    } else if (/^(PIS|COFINS)/.test(pai)) {
      kind = 'cst_pis_cofins';
    }
    // `IPITrib` e `IPINT` caem aqui: não há tipo de IPI em fiscal_codes.
    if (kind === null) {
      continue;
    }

    const doc = /<xs:documentation>([\s\S]*?)<\/xs:documentation>/.exec(corpo);
    const descricoes = doc === null ? new Map<string, string>() : descricoesDo(doc[1]!);

    for (const enumeracao of corpo.matchAll(/<xs:enumeration value="([^"]+)"/g)) {
      const code = enumeracao[1]!;
      const chave = `${kind}:${code}`;
      const existente = codigos.get(chave);
      const descricao = descricoes.get(code) ?? null;

      // Primeira descrição encontrada ganha; um bloco sem descrição não apaga a
      // que outro bloco já trouxe para o mesmo código.
      if (existente === undefined) {
        codigos.set(chave, { kind, code, description: descricao });
      } else if (existente.description === null && descricao !== null) {
        existente.description = descricao;
      }
    }
  }

  return [...codigos.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code),
  );
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const indice = process.argv.indexOf('--arquivo');
  const caminho = indice === -1 ? null : process.argv[indice + 1];

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  let xsd: string;
  if (caminho !== null && caminho !== undefined) {
    xsd = await readFile(caminho, 'utf8');
    console.log(`Fonte: ${caminho}`);
  } else {
    console.log(`Fonte: ${XSD}`);
    const resposta = await fetch(XSD);
    if (!resposta.ok) {
      throw new Error(`O portal SVRS respondeu ${resposta.status}.`);
    }
    xsd = await resposta.text();
  }

  const codigos = extrair(xsd);
  const icms = codigos.filter((c) => c.kind === 'cst_icms');
  const pisCofins = codigos.filter((c) => c.kind === 'cst_pis_cofins');

  console.log(
    `\n${icms.length} CST-ICMS/CSOSN · ${pisCofins.length} CST-PIS/Cofins · ` +
      `${codigos.filter((c) => c.description === null).length} sem descrição extraída`,
  );

  if (icms.length === 0 || pisCofins.length === 0) {
    throw new Error(
      'Um dos dois conjuntos saiu vazio. A estrutura do XSD mudou — carregar ' +
        'assim deixaria a camada 3 recusando código válido como `unknown_code`.',
    );
  }

  if (!executar) {
    console.log('\nSimulação. Amostra:');
    for (const c of [...icms.slice(0, 3), ...pisCofins.slice(0, 3)]) {
      console.log(`  ${c.kind.padEnd(15)} ${c.code} · ${c.description ?? '(sem descrição)'}`);
    }
    console.log('\nUse --executar para carregar.');
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 30_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaCstPool');

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const c of codigos) {
      await client.query(
        `insert into fiscal_codes (kind, code, description, valid_from, source)
         values ($1, $2, $3, $4::date, $5)
         on conflict (kind, code, valid_from) do update set
           description = coalesce(excluded.description, fiscal_codes.description),
           source = excluded.source`,
        [c.kind, c.code, c.description, VIGENTE_DESDE, FONTE],
      );
    }
    await client.query('commit');
  } catch (causa) {
    await client.query('rollback').catch(() => undefined);
    throw causa;
  } finally {
    client.release();
  }

  const { rows } = await pool.query<{ kind: string; n: string }>(
    'select kind, count(*)::text as n from fiscal_codes group by kind order by kind',
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
