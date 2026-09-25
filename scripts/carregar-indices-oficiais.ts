/**
 * Carrega as séries de índice (IPCA, INPC, IGP-M, TR, SELIC) das fontes
 * oficiais para `financial_index_points`.
 *
 * - IPCA e INPC: IBGE SIDRA, conferidos mês a mês contra o BCB SGS;
 * - IGP-M, TR e SELIC: BCB SGS.
 *
 * A série fica `verified = true` quando a conferência passa (decisão de
 * 25/09/2026: automática quando as fontes batem). Sem `--executar`, só relata:
 * pontos, primeira e última competência, inseridos, revisões da fonte e o
 * resultado da conferência.
 *
 * ```
 * npx tsx scripts/carregar-indices-oficiais.ts
 * npx tsx scripts/carregar-indices-oficiais.ts --executar
 * npx tsx scripts/carregar-indices-oficiais.ts --desde 2000-01 --indices ipca,selic --executar
 * ```
 */
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';
import { carregarIndices, fetchJsonComTentativas } from '../src/fiscal/rules/index-loader.js';

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(nome);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }
  const desde = argumento('--desde') ?? '1994-07';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(desde)) {
    throw new Error('--desde espera AAAA-MM.');
  }
  const indices = argumento('--indices')?.split(',').map((s) => s.trim()).filter(Boolean);
  const executar = process.argv.includes('--executar');

  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 30_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaIndicesPool');
  try {
    const relatorios = await carregarIndices({
      pool,
      fetchJson: fetchJsonComTentativas(),
      now: new Date(),
      desde,
      ...(indices === undefined ? {} : { indices }),
      executar,
    });

    for (const r of relatorios) {
      console.log(
        `\n${r.indexId.toUpperCase().padEnd(6)} ${r.points} competência(s), ${r.firstPeriod ?? '—'} a ${r.lastPeriod ?? '—'}`,
      );
      console.log(`       ${r.inserted} nova(s), ${r.revisions.length} revisão(ões) da fonte`);
      for (const rev of r.revisions.slice(0, 5)) {
        console.log(`         ${rev.period}: ${(rev.before * 100).toFixed(4)}% → ${(rev.after * 100).toFixed(4)}%`);
      }
      console.log(`       ${r.verified ? 'conferida' : `NÃO conferida: ${r.notVerifiedReason}`}`);
      console.log(`       fonte: ${r.sourceRef}`);
    }
    console.log(executar ? '\nGravado.' : '\nSimulação. Use --executar para gravar.');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
