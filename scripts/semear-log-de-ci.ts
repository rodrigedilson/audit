/**
 * Semeia um event log determinístico, para o `verify` do CI ter o que verificar.
 *
 * O passo `npm run verify` do CI era **vácuo**: rodava sem `DATABASE_URL`, sobre
 * um `.roadmap/activity.jsonl` de zero bytes, e passava sempre — inclusive
 * quando não havia verificado nada. Um guard que passa em qualquer situação não
 * guarda: ele carimba.
 *
 * Este script cria um escopo fixo com eventos reais no Postgres, e o CI então
 * roda `verify --strict` contra ele. O que passa a ser exercido de ponta a
 * ponta: ler o log do Postgres, replayar, hashear e comparar — que é INV-006.
 *
 * Idempotente: pode rodar duas vezes sem duplicar.
 */
import pg from 'pg';

/** Fixos, para o CI poder passar o mesmo escopo ao `verify`. */
export const CI_TENANT = '11111111-1111-1111-1111-111111111111';
export const CI_CNPJ = '11222333000181';
const CI_PERIOD = '2027-03';

async function main(): Promise<void> {
  const connectionString = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

  if (connectionString === undefined) {
    process.stderr.write('TEST_DATABASE_URL (ou DATABASE_URL) ausente.\n');
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString, max: 1 });

  try {
    await pool.query(
      `insert into tenants (id, name, plan) values ($1::uuid, 'Escritório do CI', 'trial')
       on conflict (id) do nothing`,
      [CI_TENANT],
    );

    await pool.query(
      `insert into clients (tenant_id, cnpj, legal_name, regime)
       values ($1::uuid, $2::char(14), 'Cliente do CI', 'lucro_real')
       on conflict (tenant_id, cnpj) do nothing`,
      [CI_TENANT, CI_CNPJ],
    );

    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from events
        where tenant_id = $1::uuid and cnpj = $2::char(14)`,
      [CI_TENANT, CI_CNPJ],
    );

    if (Number(rows[0]!.n) > 0) {
      process.stdout.write(`log do CI já semeado (${rows[0]!.n} eventos).\n`);
      return;
    }

    /**
     * Eventos escolhidos para cobrir o que o replay precisa saber montar:
     * abertura de competência, dois documentos em sentidos opostos, uma
     * classificação de item e uma rejeição. Um log de um evento só não
     * distinguiria replay correto de replay que ignora metade das ações.
     */
    const eventos: [string, string, string | null, Record<string, unknown>][] = [
      ['period.opened', CI_PERIOD, CI_PERIOD, { period: CI_PERIOD }],
      [
        'doc.received',
        '35270311222333000181550010000000011234567890',
        CI_PERIOD,
        { access_key: '35270311222333000181550010000000011234567890', direction: 'inbound', total_cents: 100_000 },
      ],
      [
        'doc.received',
        '35270311222333000181550010000000021234567890',
        CI_PERIOD,
        { access_key: '35270311222333000181550010000000021234567890', direction: 'outbound', total_cents: 250_000 },
      ],
      ['item.classified', 'SKU-CI-1', null, { item_id: 'SKU-CI-1', health: 'ok' }],
      [
        'output.rejected',
        'recusado.xml',
        CI_PERIOD,
        { reason: 'schema_violation', validation_layer: 1, original_action: 'doc.received', details: 'XML de teste do CI' },
      ],
    ];

    for (const [action, taskId, period, payload] of eventos) {
      await pool.query(
        `select append_event(
           $1::uuid, $2::char(14), gen_random_uuid(), $3::text, $4::text, $5::text,
           $6::char(7), now(), '0.5.0', $7::jsonb)`,
        [CI_TENANT, CI_CNPJ, action, taskId, CI_TENANT, period, JSON.stringify(payload)],
      );
    }

    process.stdout.write(
      `log do CI semeado: ${eventos.length} eventos em ${CI_TENANT}:${CI_CNPJ}\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
