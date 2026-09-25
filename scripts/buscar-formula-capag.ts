/**
 * Busca em fonte pública a fórmula de referência da CAPAG presumida e a grava
 * em `capag_reference_formulas`.
 *
 * A página da PGFN no gov.br ("Consultar a Capacidade de Pagamento") é lida
 * sempre, e a fórmula dela fica conferida quando todo coeficiente está, literal,
 * na página. O que vier de outro endereço é doutrina: fica como referência, e
 * nunca conferida.
 *
 * O Claude só busca. O script baixa cada página, extrai a fórmula pelo mesmo
 * extrator do demonstrativo, e descarta a fonte cujo coeficiente não está,
 * literal, na página. Precisa de ANTHROPIC_API_KEY (a de dev serve).
 *
 * ```
 * npx tsx scripts/buscar-formula-capag.ts
 * npx tsx scripts/buscar-formula-capag.ts --executar
 * npx tsx scripts/buscar-formula-capag.ts --urls https://a.exemplo/x,https://b.exemplo/y
 * npx tsx scripts/buscar-formula-capag.ts --grupos pj_inativa --executar
 * ```
 */
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';
import { ClaudeCapagExtractor } from '../src/fiscal/forensics/capag/claude-capag-extractor.js';
import { URL_OFICIAL_PGFN, buscarUrls, extrairReferencias, fetchBytesPadrao } from '../src/fiscal/forensics/capag/capag-reference-search.js';

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(nome);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const client = new Anthropic();
  const extractor = new ClaudeCapagExtractor({ client });

  const informadas = argumento('--urls')?.split(',').map((u) => u.trim()).filter(Boolean);
  const urls = informadas ?? [...new Set([URL_OFICIAL_PGFN, ...(await buscarUrls(client))])];
  console.log(`${urls.length} página(s) para ler:`);
  for (const u of urls) console.log(`  ${u}`);

  const relatorio = await extrairReferencias(urls, extractor, fetchBytesPadrao);
  // Para completar um grupo sem gravar de novo os que já estão carregados.
  const grupos = argumento('--grupos')?.split(',').map((g) => g.trim()).filter(Boolean);
  if (grupos) relatorio.candidates = relatorio.candidates.filter((c) => grupos.includes(c.group));

  for (const d of relatorio.discarded) console.log(`\nDescartada: ${d.url}\n  ${d.reason}`);
  if (relatorio.candidates.length === 0) {
    console.log('\nNenhuma fórmula com todos os trechos conferidos nas páginas.');
    return;
  }
  for (const c of relatorio.candidates) {
    const termos = c.terms.map((t) => `${t.coefficient}·${t.variable}${t.block === 'added' ? ' (somada)' : ''}`).join(' + ');
    const tipo = c.verified ? 'oficial (PGFN), conferida' : 'doutrina, não conferida';
    console.log(`\nGrupo ${c.group}, ${tipo}: ${c.incomeMultiplier} × (${termos})`);
    console.log(`  ${c.sources.length} fonte(s): ${c.sources.map((s) => s.url).join(', ')}`);
  }

  if (!executar) {
    console.log('\nSimulação. Use --executar para gravar.');
    return;
  }

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL não definida.');
  const pool = new pg.Pool({ connectionString, max: 1 });
  ignorarErroDeClienteOcioso(pool, 'BuscaCapagPool');
  try {
    for (const c of relatorio.candidates) {
      await pool.query(
        `insert into capag_reference_formulas
           (capag_group, income_multiplier, terms, sources, legal_basis, model, source_kind, verified)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)`,
        [
          c.group,
          c.incomeMultiplier,
          JSON.stringify(c.terms),
          JSON.stringify(c.sources),
          c.legalBasis,
          extractor.name,
          c.sourceKind,
          c.verified,
        ],
      );
    }
    const conferidas = relatorio.candidates.filter((c) => c.verified).length;
    console.log(`\nGravadas ${relatorio.candidates.length} fórmula(s) de referência, ${conferidas} conferida(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
