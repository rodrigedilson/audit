/**
 * Busca em fonte pública a fórmula de referência da CAPAG presumida e a grava
 * em `capag_reference_formulas`, sempre como NÃO conferida.
 *
 * A fórmula oficial só aparece no REGULARIZE, com login do contribuinte
 * (Portaria PGFN 6.757/2022, art. 28). O que se acha em público é doutrina:
 * serve de referência ao lado do demonstrativo, e nunca para afirmar a CAPAG.
 *
 * O Claude só busca. O script baixa cada página, extrai a fórmula pelo mesmo
 * extrator do demonstrativo, e descarta a fonte cujo coeficiente não está,
 * literal, na página. Precisa de ANTHROPIC_API_KEY (a de dev serve).
 *
 * ```
 * npx tsx scripts/buscar-formula-capag.ts
 * npx tsx scripts/buscar-formula-capag.ts --executar
 * npx tsx scripts/buscar-formula-capag.ts --urls https://a.exemplo/x,https://b.exemplo/y
 * ```
 */
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';
import { ClaudeCapagExtractor } from '../src/fiscal/forensics/capag/claude-capag-extractor.js';
import { buscarUrls, extrairReferencias, fetchBytesPadrao } from '../src/fiscal/forensics/capag/capag-reference-search.js';

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(nome);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const client = new Anthropic();
  const extractor = new ClaudeCapagExtractor({ client });

  const informadas = argumento('--urls')?.split(',').map((u) => u.trim()).filter(Boolean);
  const urls = informadas ?? (await buscarUrls(client));
  console.log(`${urls.length} página(s) para ler:`);
  for (const u of urls) console.log(`  ${u}`);

  const relatorio = await extrairReferencias(urls, extractor, fetchBytesPadrao);

  for (const d of relatorio.discarded) console.log(`\nDescartada: ${d.url}\n  ${d.reason}`);
  if (relatorio.candidates.length === 0) {
    console.log('\nNenhuma fórmula com todos os trechos conferidos nas páginas.');
    return;
  }
  for (const c of relatorio.candidates) {
    const termos = c.terms.map((t) => `${t.coefficient}·${t.variable}${t.block === 'added' ? ' (somada)' : ''}`).join(' + ');
    console.log(`\nGrupo ${c.group}: ${c.incomeMultiplier} × (${termos})`);
    console.log(`  ${c.sources.length} fonte(s): ${c.sources.map((s) => s.url).join(', ')}`);
  }

  if (!executar) {
    console.log('\nSimulação. Use --executar para gravar (sempre como não conferida).');
    return;
  }

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL não definida.');
  const pool = new pg.Pool({ connectionString, max: 1 });
  ignorarErroDeClienteOcioso(pool, 'BuscaCapagPool');
  try {
    for (const c of relatorio.candidates) {
      await pool.query(
        `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, legal_basis, model)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        [c.group, c.incomeMultiplier, JSON.stringify(c.terms), JSON.stringify(c.sources), c.legalBasis, extractor.name],
      );
    }
    console.log(`\nGravadas ${relatorio.candidates.length} fórmula(s) de referência, não conferidas.`);
  } finally {
    await pool.end();
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
