/**
 * Carrega CST-IBS/CBS, cClassTrib e o pareamento entre os dois.
 *
 * Fonte: **Portal da Conformidade Fácil (SVRS)**, que publica as tabelas do
 * Informe Técnico RT 2025.002 — o documento que consolida a classificação do IBS
 * e da CBS e revoga o IT RT 2024.001.
 *
 * https://dfe-portal.svrs.rs.gov.br/Cff/ClassificacaoTributaria
 *
 * Existe uma API oficial em `https://cff.svrs.rs.gov.br/api/v1/consultas/classTrib`,
 * e ela é o caminho certo no longo prazo — mas exige autenticação mútua com
 * certificado ICP-Brasil. Quando o cofre tiver um A1 guardado, trocar este
 * carregador por uma chamada autenticada é uma tarde de trabalho, e aí a
 * atualização passa a ser um `certificate.used` com `purpose` próprio. Até lá, o
 * portal serve a mesma tabela sem certificado.
 *
 * O que entra:
 *
 * - `fiscal_codes` kind `cst_ibs_cbs`: os CSTs, com nome e vigência.
 * - `fiscal_codes` kind `cclasstrib`: os códigos de classificação tributária.
 * - `cclasstrib_cst`: o par cClassTrib × CST. **É o dado que faltava para a
 *   camada 3 poder recusar `code_incompatible`** — a combinação que a SEFAZ
 *   autoriza e a apuração pune. Cada cClassTrib pertence a exatamente um CST na
 *   tabela oficial, e é essa relação que vira o par; não há inferência por
 *   prefixo nenhuma.
 *
 * A vigência vem do próprio registro (`DthIniVig`, `DthFimVig`), e não da data
 * da carga. Datar pela carga faria uma classificação feita em junho parecer ter
 * usado um código publicado em setembro — e a vigência em `fiscal_codes` existe
 * justamente para que código revogado não invalide classificação feita quando
 * ele valia.
 *
 * A procedência de cada linha traz a URL da legislação que o próprio portal
 * informa por código, além do IT. Quem audita a validação pergunta de onde saiu
 * o código, não de onde saiu a tabela.
 *
 * ```
 * npx tsx scripts/carregar-classificacao-ibs-cbs.ts
 * npx tsx scripts/carregar-classificacao-ibs-cbs.ts --executar
 * npx tsx scripts/carregar-classificacao-ibs-cbs.ts --arquivo tabela.json --executar
 * ```
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

const PORTAL = 'https://dfe-portal.svrs.rs.gov.br/Cff/ClassificacaoTributaria';
const FONTE = 'IT RT 2025.002 · Portal da Conformidade Fácil (SVRS)';

interface Classificacao {
  CodClassTrib: string;
  NomeClassTrib: string;
  Cst: string;
  DthIniVig: string | null;
  DthFimVig: string | null;
  TexUrlLegislacao?: string | null;
}

interface RegistroDeCst {
  Cst: string;
  NomeCst: string;
  DthIniVig: string | null;
  DthFimVig: string | null;
  ClassificacoesTributarias?: Classificacao[];
}

/**
 * A tabela vem embutida na página como `var dadosOriginais = [...]`.
 *
 * Extrair do HTML é frágil por natureza, e por isso a falha é alta e explícita:
 * melhor o carregador parar dizendo que a página mudou do que carregar meia
 * tabela e deixar a camada 3 recusando código válido como `unknown_code`.
 */
function extrair(html: string): RegistroDeCst[] {
  const marcador = 'var dadosOriginais = ';
  const inicio = html.indexOf(marcador);
  if (inicio === -1) {
    throw new Error(
      `Não encontrei "dadosOriginais" no HTML do portal. A página mudou de forma.\n` +
        `Salve a tabela pelo botão de export JSON e rode com --arquivo <caminho>.`,
    );
  }

  const abre = html.indexOf('[', inicio);
  let nivel = 0;
  let fim = -1;
  for (let i = abre; i < html.length; i += 1) {
    if (html[i] === '[') nivel += 1;
    else if (html[i] === ']') {
      nivel -= 1;
      if (nivel === 0) {
        fim = i + 1;
        break;
      }
    }
  }

  if (fim === -1) {
    throw new Error('O array de dados do portal está truncado.');
  }

  return JSON.parse(html.slice(abre, fim)) as RegistroDeCst[];
}

/** `2025-05-01T00:00:00` → `2025-05-01`. Nulo vira nulo. */
function data(valor: string | null | undefined): string | null {
  return valor === null || valor === undefined ? null : valor.slice(0, 10);
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const indiceArquivo = process.argv.indexOf('--arquivo');
  const arquivo = indiceArquivo === -1 ? null : process.argv[indiceArquivo + 1];

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  let registros: RegistroDeCst[];
  if (arquivo !== null && arquivo !== undefined) {
    const conteudo = await readFile(arquivo, 'utf8');
    registros = conteudo.trimStart().startsWith('[')
      ? (JSON.parse(conteudo) as RegistroDeCst[])
      : extrair(conteudo);
    console.log(`Fonte: ${arquivo}`);
  } else {
    console.log(`Fonte: ${PORTAL}`);
    const resposta = await fetch(PORTAL);
    if (!resposta.ok) {
      throw new Error(`O portal respondeu ${resposta.status}.`);
    }
    registros = extrair(await resposta.text());
  }

  const classificacoes = registros.flatMap((r) => r.ClassificacoesTributarias ?? []);

  console.log(`\n${registros.length} CST(s), ${classificacoes.length} cClassTrib.`);

  const semCst = classificacoes.filter((c) => !registros.some((r) => r.Cst === c.Cst));
  if (semCst.length > 0) {
    throw new Error(
      `${semCst.length} cClassTrib apontam para CST que não está na tabela. ` +
        'Carregar assim criaria par inválido, que é o oposto do que esta tabela serve para detectar.',
    );
  }

  const comFim = classificacoes.filter((c) => c.DthFimVig !== null).length;
  console.log(`${comFim} cClassTrib com vigência encerrada — entram com valid_to.`);

  if (!executar) {
    console.log('\nSimulação. Amostra do que entraria:');
    for (const r of registros.slice(0, 3)) {
      console.log(`  CST ${r.Cst} · ${r.NomeCst} · desde ${data(r.DthIniVig)}`);
    }
    for (const c of classificacoes.slice(0, 3)) {
      console.log(`  cClassTrib ${c.CodClassTrib} → CST ${c.Cst} · ${c.NomeClassTrib.slice(0, 50)}`);
    }
    console.log('\nUse --executar para carregar.');
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 30_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaIbsCbsPool');

  const client = await pool.connect();
  try {
    // Uma transação para as três tabelas: meia carga deixaria a camada 3
    // recusando código válido como `unknown_code`, que é pior do que não ter
    // tabela nenhuma — tabela vazia reporta "não verificado", e é honesto.
    await client.query('begin');

    for (const r of registros) {
      await client.query(
        `insert into fiscal_codes (kind, code, description, valid_from, valid_to, source)
         values ('cst_ibs_cbs', $1, $2, coalesce($3::date, '2025-01-01'), $4::date, $5)
         on conflict (kind, code, valid_from) do update set
           description = excluded.description,
           valid_to = excluded.valid_to,
           source = excluded.source`,
        [r.Cst, r.NomeCst, data(r.DthIniVig), data(r.DthFimVig), FONTE],
      );
    }

    for (const c of classificacoes) {
      const fonte =
        c.TexUrlLegislacao === null || c.TexUrlLegislacao === undefined || c.TexUrlLegislacao === ''
          ? FONTE
          : `${FONTE} · ${c.TexUrlLegislacao}`;

      await client.query(
        `insert into fiscal_codes (kind, code, description, valid_from, valid_to, source)
         values ('cclasstrib', $1, $2, coalesce($3::date, '2025-01-01'), $4::date, $5)
         on conflict (kind, code, valid_from) do update set
           description = excluded.description,
           valid_to = excluded.valid_to,
           source = excluded.source`,
        [c.CodClassTrib, c.NomeClassTrib, data(c.DthIniVig), data(c.DthFimVig), fonte],
      );

      await client.query(
        `insert into cclasstrib_cst (cclasstrib, cst_ibs_cbs, description)
         values ($1, $2, $3)
         on conflict (cclasstrib, cst_ibs_cbs) do update set description = excluded.description`,
        [c.CodClassTrib, c.Cst, c.NomeClassTrib],
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
    `select kind, count(*)::text as n from fiscal_codes group by kind
     union all
     select 'cclasstrib_cst_pares', count(*)::text from cclasstrib_cst
     order by kind`,
  );
  console.log('\nDepois da carga:');
  for (const linha of rows) {
    console.log(`  ${linha.kind.padEnd(24)} ${linha.n}`);
  }

  console.log(
    '\nA camada 3 passa a recusar par cClassTrib × CST inválido como\n' +
      '`code_incompatible`, severidade crítica. NCM, NBS, CST-ICMS e CST-PIS/Cofins\n' +
      'continuam sem fonte, e continuam reportando `not_verified`.',
  );

  await pool.end().catch(() => undefined);
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
