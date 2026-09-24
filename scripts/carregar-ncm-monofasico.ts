/**
 * Marca em `ncm_flags` os NCMs sujeitos à incidência monofásica de PIS/Cofins.
 *
 * Fontes, as duas oficiais:
 *
 * - **Tabela 4.3.10 da EFD-Contribuições** (RFB, portal SPED), que a RFB
 *   publica só em `.doc`: `http://sped.rfb.gov.br/arquivo/show/1638`. A versão e
 *   a data saem do título da página, porque o `.doc` não as traz no corpo.
 * - **Anexos I e II da Lei nº 10.485/2002** (Planalto), para as autopeças: a
 *   tabela as cita pela lei, sem listar NCM.
 *
 * O que entra é o que vale **hoje**: `ncm_flags` não tem término de vigência, e
 * o catálogo a lê sem data. Marcar um regime encerrado — as bebidas frias por
 * pauta, que acabaram em 2015 — diria ao contador que é monofásico o que não é
 * mais. Pela mesma razão, ficam de fora da marcação as linhas de revenda da
 * tabela e as alíquotas reduzidas da nafta (códigos 150 a 153), que são
 * diferenciadas sem ser monofásicas.
 *
 * **ST fica como está.** `tax_substitution` depende da UF, e `ncm_flags` não
 * tem UF: marcar ST por NCM diria "tem ST" para um estado que não a aplica.
 *
 * A marcação é informativa (volta em `ncm_flags` na validação da
 * classificação) e não entra em nenhum cálculo. O monofásico acaba com a
 * extinção de PIS e Cofins em 2027, quando a CBS entra.
 *
 * A carga substitui só o que ela mesma gravou (nota iniciada por
 * `Tabela 4.3.10`): um NCM que saiu da tabela sai da marcação. Sem
 * `--executar`, só relata.
 *
 * ```
 * npx tsx scripts/carregar-ncm-monofasico.ts
 * npx tsx scripts/carregar-ncm-monofasico.ts --executar
 * npx tsx scripts/carregar-ncm-monofasico.ts --arquivo t4310.doc --lei-arquivo l10485.htm
 * ```
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';
import { extrairCelulas, lerRegistros } from '../src/fiscal/catalog/monophasic-table.js';
import {
  lerAnexosLei10485,
  montarFlags,
  textoDoHtml,
} from '../src/fiscal/catalog/monophasic-flags.js';

const PAGINA_TABELA = 'http://sped.rfb.gov.br/arquivo/show/1638';
const DOWNLOAD_TABELA = 'http://sped.rfb.gov.br/arquivo/download/1638';
const LEI_10485 = 'https://www.planalto.gov.br/ccivil_03/leis/2002/l10485.htm';

/** Prefixo das notas desta carga. É por ele que a carga reconhece o que é seu. */
const PREFIXO_NOTA = 'Tabela 4.3.10';

/** Linhas por `INSERT`. 3 parâmetros × 500 = 1.500. */
const LOTE = 500;

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(nome);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * Baixa com três tentativas. O Planalto derruba conexão com frequência
 * (`ECONNRESET`), e uma carga de referência não deveria depender de sorte — mas
 * também não pode insistir para sempre: na terceira falha, diz qual URL e por
 * quê, e aponta o `--arquivo`.
 */
async function baixar(url: string): Promise<Uint8Array> {
  let ultima: unknown;
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    try {
      const resposta = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (audit-carga-referencia)' },
        signal: AbortSignal.timeout(90_000),
      });
      if (!resposta.ok) {
        throw new Error(`respondeu ${resposta.status}`);
      }
      return new Uint8Array(await resposta.arrayBuffer());
    } catch (causa) {
      ultima = causa;
      await new Promise((r) => setTimeout(r, 3_000 * tentativa));
    }
  }
  const motivo =
    ultima instanceof Error ? `${ultima.message}${ultima.cause ? ` (${String(ultima.cause)})` : ''}` : String(ultima);
  throw new Error(
    `Não consegui baixar ${url} em três tentativas: ${motivo}. ` +
      'Baixe manualmente e use --arquivo / --lei-arquivo.',
  );
}

/** "Versão 1.25 - Atualizada em 30.03.2026", do título da página do SPED. */
async function versaoDaTabela(): Promise<string> {
  const html = new TextDecoder('utf-8').decode(await baixar(PAGINA_TABELA));
  const titulo = textoDoHtml(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '');
  const versao = /Vers[ãa]o\s+([\d.]+)\s*-\s*Atualizada em\s+([\d.]+)/i.exec(titulo);
  if (versao === null) {
    throw new Error(`Não achei a versão no título da página: "${titulo}".`);
  }
  return `v${versao[1]} de ${versao[2]}`;
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const arquivoTabela = argumento('--arquivo');
  const arquivoLei = argumento('--lei-arquivo');

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  const doc =
    arquivoTabela === null ? await baixar(DOWNLOAD_TABELA) : new Uint8Array(await readFile(arquivoTabela));
  const versao = arquivoTabela === null ? await versaoDaTabela() : `arquivo ${arquivoTabela}`;
  // O Planalto serve em Windows-1252.
  const lei = new TextDecoder('windows-1252').decode(
    arquivoLei === null ? await baixar(LEI_10485) : new Uint8Array(await readFile(arquivoLei)),
  );
  const fonte = `${PREFIXO_NOTA} da EFD-Contribuições (RFB, ${versao})`;
  console.log(`Fonte: ${fonte}\nAutopeças: Lei nº 10.485/2002, Anexos I e II (Planalto)`);

  const registros = lerRegistros(extrairCelulas(doc));
  const anexos = lerAnexosLei10485(textoDoHtml(lei));
  console.log(
    `${registros.length} registros na tabela · Anexo I com ${anexos.anexoI.inclusoes.length} ` +
      `códigos · Anexo II com ${anexos.anexoII.length} itens`,
  );

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 60_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaMonofasicoPool');

  try {
    const { rows } = await pool.query<{ code: string }>(
      `select trim(code) as code from fiscal_codes
        where kind = 'ncm' and (valid_to is null or valid_to >= current_date)`,
    );
    if (rows.length === 0) {
      throw new Error(
        'Nenhum NCM oficial em fiscal_codes. Carregue antes: npx tsx scripts/carregar-ncm-oficial.ts --executar',
      );
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const montagem = montarFlags(registros, anexos, rows.map((r) => r.code), hoje, fonte);

    console.log(`\n${montagem.linhas.length} NCMs monofásicos vigentes em ${hoje}.`);
    const comRessalva = montagem.linhas.filter((l) => /somente Ex|exceto Ex|Anexo II, item/.test(l.note));
    console.log(`  ${comRessalva.length} com ressalva de ex-tarifário ou de destino (dita na nota).`);

    if (montagem.semCorrespondencia.length > 0) {
      console.log('\nCitados pela fonte sem NCM oficial correspondente (não marcados):');
      for (const s of montagem.semCorrespondencia) {
        console.log(`  ${s.prefixo.padEnd(9)} ${s.origem}`);
      }
    }
    if (montagem.remissoesNaoLidas.length > 0) {
      console.log('\nRegistros vigentes que remetem a texto que esta carga não lê (não marcados):');
      for (const r of montagem.remissoesNaoLidas) {
        console.log(`  ${r.codigo} ${r.texto.slice(0, 100)}`);
      }
    }

    if (montagem.linhas.length === 0) {
      throw new Error('Nenhum NCM montado. O formato da fonte mudou.');
    }

    if (!executar) {
      console.log('\nSimulação. Amostra:');
      for (const linha of montagem.linhas.filter((_l, i) => i % 250 === 0)) {
        console.log(`  ${linha.ncm} desde ${linha.validFrom} · ${linha.note.slice(fonte.length + 3, fonte.length + 120)}`);
      }
      console.log('\nUse --executar para carregar.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rowCount: removidas } = await client.query(
        'delete from ncm_flags where note like $1 and tax_substitution = false',
        [`${PREFIXO_NOTA}%`],
      );

      for (let i = 0; i < montagem.linhas.length; i += LOTE) {
        const lote = montagem.linhas.slice(i, i + LOTE);
        const valores: unknown[] = [];
        const grupos = lote.map((linha, j) => {
          valores.push(linha.ncm, linha.validFrom, linha.note);
          return `($${j * 3 + 1}, true, false, $${j * 3 + 3}, $${j * 3 + 2}::date)`;
        });
        await client.query(
          `insert into ncm_flags (ncm, monophasic, tax_substitution, note, valid_from)
           values ${grupos.join(', ')}
           on conflict (ncm, valid_from) do update set
             monophasic = true,
             note = excluded.note`,
          valores,
        );
      }

      await client.query('commit');
      console.log(`\nCarregado: ${montagem.linhas.length} NCMs (${removidas ?? 0} linhas antigas desta carga substituídas).`);
    } catch (causa) {
      await client.query('rollback').catch(() => undefined);
      throw causa;
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
