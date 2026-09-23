/**
 * Carrega a tabela oficial de NBS em `fiscal_codes`.
 *
 * Fonte: **MDIC**, CSV da NBS 2.0:
 * `https://www.gov.br/mdic/pt-br/images/REPOSITORIO/scs/decos/NBS/NBSa_2-0.csv`
 *
 * São 920 códigos de 9 dígitos. A nomenclatura é hierárquica e o arquivo também
 * traz níveis de 3, 5, 6, 7 e 8 dígitos — capítulos e posições, que não são NBS
 * de item e não aparecem em documento fiscal. Só os de 9 entram, pelo mesmo
 * motivo do NCM: carregar os níveis faria a camada 3 aceitar `1.01` como código
 * de serviço válido.
 *
 * **Conferência contra uma segunda fonte oficial.** O Anexo VIII do RTC — a
 * tabela de correlação item LC 116 × NBS × cClassTrib publicada pelo CGNFS-e em
 * 2025 — usa 675 códigos NBS, e **todos os 675 estão nos 920 deste arquivo**.
 * Importa porque a NBS 2.0 é de 2018 e a pergunta óbvia é se ela envelheceu; a
 * tabela da reforma respondeu que não.
 *
 * O Anexo VIII **não** serve como fonte da tabela: ele é correlação, cobre só
 * serviços do ISS e tem 675 dos 920. Carregá-lo faria a camada 3 acusar NBS
 * válida como `unknown_code`, severidade alta — pior que tabela vazia, que
 * reporta "não verificado" e é honesto.
 *
 * **Limitação, dita em vez de escondida:** o CSV não traz vigência por código.
 * Todas as linhas entram com a data da versão 2.0, e não com a vigência
 * individual de cada código. Se um código for revogado, este carregador não tem
 * como saber — a fonte não diz.
 *
 * ```
 * npx tsx scripts/carregar-nbs-oficial.ts
 * npx tsx scripts/carregar-nbs-oficial.ts --executar
 * ```
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

const CSV = 'https://www.gov.br/mdic/pt-br/images/REPOSITORIO/scs/decos/NBS/NBSa_2-0.csv';

/**
 * Vigência da versão 2.0.
 *
 * A página do MDIC lista a versão vigente como NBS 2.0, publicada pelas
 * Portarias 1.429/2018 e 2.000/2018, e o arquivo é o "com alterações 6.12.18".
 * A data aqui é a da Portaria 2.000; a procedência completa vai no `source` de
 * cada linha, que é onde quem audita procura.
 */
const VIGENTE_DESDE = '2018-12-18';
const FONTE = 'NBS 2.0 · Portarias MDIC 1.429/2018 e 2.000/2018 · gov.br/mdic';

/** Parâmetros por linha no `INSERT`. Ver o lote do carregador de NCM. */
const LOTE = 400;

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const indice = process.argv.indexOf('--arquivo');
  const caminho = indice === -1 ? null : process.argv[indice + 1];

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  let conteudo: string;
  if (caminho !== null && caminho !== undefined) {
    // O arquivo do MDIC é latin1, e não UTF-8: lido como UTF-8, "Serviços"
    // vira "Servi�os" e a descrição entra corrompida no banco.
    conteudo = (await readFile(caminho)).toString('latin1');
    console.log(`Fonte: ${caminho}`);
  } else {
    console.log(`Fonte: ${CSV}`);
    const resposta = await fetch(CSV);
    if (!resposta.ok) {
      throw new Error(`O MDIC respondeu ${resposta.status}.`);
    }
    conteudo = Buffer.from(await resposta.arrayBuffer()).toString('latin1');
  }

  const linhas = conteudo.split(/\r?\n/).slice(1);
  const itens: { codigo: string; descricao: string }[] = [];
  let niveis = 0;

  for (const linha of linhas) {
    const separador = linha.indexOf(';');
    if (separador === -1) {
      continue;
    }

    const bruto = linha.slice(0, separador).trim();
    const descricao = linha.slice(separador + 1).trim();
    const digitos = bruto.replace(/\D/g, '');

    if (digitos.length === 9 && descricao !== '') {
      itens.push({ codigo: digitos, descricao });
    } else if (digitos.length > 0) {
      niveis += 1;
    }
  }

  console.log(`\n${itens.length} NBS de 9 dígitos · ${niveis} níveis hierárquicos ignorados.`);

  if (itens.length === 0) {
    throw new Error('Nenhum código de 9 dígitos no arquivo. O formato da fonte mudou.');
  }

  if (!executar) {
    console.log('\nSimulação. Amostra:');
    for (const item of itens.slice(0, 3)) {
      console.log(`  ${item.codigo} · ${item.descricao.slice(0, 80)}`);
    }
    console.log('\nUse --executar para carregar.');
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 60_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaNbsPool');

  const client = await pool.connect();
  try {
    await client.query('begin');

    for (let i = 0; i < itens.length; i += LOTE) {
      const lote = itens.slice(i, i + LOTE);
      const valores: unknown[] = [];
      const grupos = lote.map((item, j) => {
        const base = j * 2;
        valores.push(item.codigo, item.descricao);
        return `('nbs', $${base + 1}, $${base + 2}, '${VIGENTE_DESDE}'::date, $${
          lote.length * 2 + 1
        })`;
      });
      valores.push(FONTE);

      await client.query(
        `insert into fiscal_codes (kind, code, description, valid_from, source)
         values ${grupos.join(', ')}
         on conflict (kind, code, valid_from) do update set
           description = excluded.description,
           source = excluded.source`,
        valores,
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
