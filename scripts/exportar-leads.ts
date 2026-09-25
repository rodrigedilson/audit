/**
 * Exporta os leads do diagnóstico público em CSV, na saída padrão. Só leitura.
 *
 * Sai só o que o visitante consentiu em deixar: e-mail, data do consentimento,
 * origem, quando fez o diagnóstico e se o relatório foi enviado. Nenhum dado do
 * relatório — ele nem fica guardado depois do envio.
 *
 * ```
 * doppler run --project audit --config prd -- npx tsx scripts/exportar-leads.ts > leads.csv
 * doppler run --project audit --config prd -- npx tsx scripts/exportar-leads.ts --desde 2026-09-01
 * ```
 */
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** CSV com aspas duplas; fórmula no começo da célula é neutralizada para planilha. */
function celula(valor: unknown): string {
  let texto = valor === null || valor === undefined ? '' : valor instanceof Date ? valor.toISOString() : String(valor);
  if (/^[=+\-@]/.test(texto)) texto = `'${texto}`;
  return `"${texto.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL ausente.');
  const desde = argumento('--desde');
  if (desde !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    throw new Error('--desde espera AAAA-MM-DD.');
  }

  const pool = new pg.Pool({ connectionString: url });
  ignorarErroDeClienteOcioso(pool, 'exportar-leads');
  try {
    const { rows } = await pool.query(
      `select email, email_consent_at, source, created_at, email_sent_at
         from readiness_reports
        where email is not null and ($1::date is null or created_at >= $1::date)
        order by created_at`,
      [desde ?? null],
    );
    const colunas = ['email', 'email_consent_at', 'source', 'created_at', 'email_sent_at'];
    process.stdout.write(`${colunas.join(',')}\n`);
    for (const r of rows) {
      process.stdout.write(`${colunas.map((c) => celula((r as Record<string, unknown>)[c])).join(',')}\n`);
    }
    process.stderr.write(`${rows.length} lead(s).\n`);
  } finally {
    await pool.end();
  }
}

main().catch((erro: unknown) => {
  process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
  process.exit(1);
});
