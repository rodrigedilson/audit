/**
 * Publica as regras de creditamento do Lucro Real em `tax_rules`.
 *
 * `tax_rules` nasce vazia de propósito (Onda 6): sem regra publicada o valor
 * devido vem `null` com o motivo, e não um número assumido. Este script preenche
 * o que é **direito posto e antigo** — a não-cumulatividade de ICMS, IPI, PIS e
 * Cofins — e não toca nas alíquotas de referência da reforma, que continuam sem
 * fonte conferida.
 *
 * A distinção importa: recusei semear a alíquota do IBS/CBS porque os números
 * citados por terceiros (Res. CGIBS 14/2026) não foram conferidos em texto
 * oficial. A não-cumulatividade do PIS/Cofins é lei de 2002 e 2003.
 *
 * **O que `credit_share = 1.0` afirma, e o que não afirma.** Afirma que todo o
 * tributo destacado nas entradas é aproveitável. A lei condiciona o crédito ao
 * enquadramento do bem ou serviço como insumo, e há exclusões — este sistema não
 * avalia enquadramento, então 1.0 é **premissa de trabalho** e está escrita como
 * tal na coluna `source`, que aparece na memória de cálculo.
 *
 *   npx tsx scripts/publicar-regras-lucro-real.ts            # mostra o que faria
 *   npx tsx scripts/publicar-regras-lucro-real.ts --executar
 */
import pg from 'pg';
import { loadDotEnv } from '../src/config/dotenv.js';

loadDotEnv();

const EXECUTAR = process.argv.includes('--executar');

const PREMISSA =
  'Premissa: 100% do tributo destacado nas entradas e aproveitavel. A lei ' +
  'condiciona o credito ao enquadramento como insumo, que este sistema nao avalia.';

interface Regra {
  tax: string;
  validFrom: string;
  source: string;
}

/**
 * Uma regra por tributo, com a vigência da própria norma que a instituiu.
 *
 * As datas não são decorativas: a apuração resolve a regra vigente no primeiro
 * dia da competência, então uma competência de 2003 não deve receber o crédito
 * de Cofins, que só passou a existir em fevereiro de 2004.
 */
const REGRAS: readonly Regra[] = [
  {
    tax: 'icms',
    validFrom: '1996-11-01',
    source: `Nao-cumulatividade do ICMS: CF art. 155 par. 2 I; LC 87/1996 arts. 19 e 20. ${PREMISSA}`,
  },
  {
    tax: 'ipi',
    validFrom: '1988-10-05',
    source: `Nao-cumulatividade do IPI: CF art. 153 par. 3 II. ${PREMISSA}`,
  },
  {
    tax: 'pis',
    validFrom: '2002-12-01',
    source: `PIS nao-cumulativo: Lei 10.637/2002 art. 3. ${PREMISSA}`,
  },
  {
    tax: 'cofins',
    validFrom: '2004-02-01',
    source: `Cofins nao-cumulativa: Lei 10.833/2003 art. 3. ${PREMISSA}`,
  },
];

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined) {
    process.stderr.write('DATABASE_URL ausente.\n');
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 });

  try {
    const { rows: existentes } = await pool.query<{ tax: string; value: string; source: string }>(
      `select tax, value::text, source from tax_rules
        where kind = 'credit_share' and regime = 'lucro_real' order by tax`,
    );

    if (existentes.length > 0) {
      process.stdout.write('já publicadas para lucro_real:\n');
      for (const r of existentes) {
        process.stdout.write(`  ${r.tax.padEnd(7)} ${r.value}  ${r.source.slice(0, 70)}\n`);
      }
      process.stdout.write('\n');
    }

    process.stdout.write('a publicar (kind=credit_share, regime=lucro_real, value=1.0):\n');
    for (const regra of REGRAS) {
      process.stdout.write(`  ${regra.tax.padEnd(7)} desde ${regra.validFrom}  ${regra.source.split('.')[0]}\n`);
    }
    process.stdout.write('\n');

    if (!EXECUTAR) {
      process.stdout.write(
        'Simulação. Nada foi gravado.\n' +
          '  npx tsx scripts/publicar-regras-lucro-real.ts --executar\n\n' +
          'Reversível: `delete from tax_rules where kind = \'credit_share\'\n' +
          "  and regime = 'lucro_real'`. Diferente do event log, `tax_rules` é\n" +
          '  dado normativo e pode ser corrigido.\n',
      );
      return;
    }

    for (const regra of REGRAS) {
      await pool.query(
        `insert into tax_rules (kind, regime, tax, value, valid_from, source)
         values ('credit_share', 'lucro_real', $1, 1.0, $2::date, $3)
         on conflict (kind, regime, tax, valid_from) where regime is not null
         do update set value = excluded.value, source = excluded.source`,
        [regra.tax, regra.validFrom, regra.source],
      );
      process.stdout.write(`  publicada: ${regra.tax}\n`);
    }

    process.stdout.write('\nConfira o efeito na apuração:\n');
    process.stdout.write('  GET /v1/clients/04552217000165/assessments/2025-07\n');
  } finally {
    await pool.end();
  }
}

await main();
