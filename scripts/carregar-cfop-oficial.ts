/**
 * Carrega a tabela oficial de CFOP em `fiscal_codes`.
 *
 * `fiscal_codes` nasce vazia de propósito, e tabela vazia significa **não
 * validado**, nunca "ok": a camada 3 reporta `not_verified` para cada código
 * cujo tipo não tem tabela carregada. É honesto, e é também a razão de o painel
 * mostrar hoje 474 itens sem nenhuma verificação de código de verdade.
 *
 * A fonte é a tabela `cfops` do `sped-genius-hub`, que vive no mesmo banco: 238
 * CFOPs com descrição, base legal (Convênio SINIEF s/n de 1970) e artigo. É dado
 * real, com procedência — e é por isso que ele pode entrar numa tabela cujo
 * contrato é "aqui só há código oficial".
 *
 * **Só CFOP.** NCM, NBS, CST-ICMS, CST-PIS/Cofins, CST-IBS/CBS e cClassTrib
 * continuam vazios, e continuam reportando `not_verified` — que é a resposta
 * certa enquanto não houver fonte com procedência para eles. Derivar CST a
 * partir dos `typical_*_csts` da tabela de CFOP daria uma lista plausível e
 * inventada: "CSTs que aparecem como típicos no nosso manual" não é a tabela
 * oficial de CST, e carimbá-la como oficial é exatamente o que este produto se
 * recusa a fazer.
 *
 * `is_custom` é filtrado: CFOP que um contador criou no manual não é código
 * oficial, e entraria validando o que ninguém publicou.
 *
 * Idempotente por `on conflict`. Sem `--executar`, só relata.
 *
 * ```
 * npx tsx scripts/carregar-cfop-oficial.ts
 * npx tsx scripts/carregar-cfop-oficial.ts --executar
 * ```
 */
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

/**
 * Vigência da carga.
 *
 * O Convênio SINIEF s/n é de 1970, e é dele que os CFOPs vêm. Datar a carga com
 * a data de hoje faria a classificação feita no mês passado parecer ter usado um
 * código que ainda não existia — e a vigência em `fiscal_codes` existe
 * justamente para que código revogado não invalide classificação feita quando
 * ele valia.
 */
const VIGENTE_DESDE = '1970-01-01';

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 30_000 });
  ignorarErroDeClienteOcioso(pool, 'CargaCfopPool');

  try {
    if ((await pool.query("select to_regclass('public.cfops') as t")).rows[0]?.t === null) {
      console.error(
        'A tabela `cfops` não existe neste banco. Ela é do sped-genius-hub, e a carga\n' +
          'só faz sentido no banco onde os dois convivem.',
      );
      process.exitCode = 1;
      return;
    }

    const { rows: antes } = await pool.query<{ kind: string; n: string }>(
      "select kind, count(*)::text as n from fiscal_codes group by kind order by kind",
    );
    console.log('fiscal_codes agora:');
    if (antes.length === 0) {
      console.log('  (vazia — todo código reporta not_verified)');
    } else {
      for (const linha of antes) {
        console.log(`  ${linha.kind.padEnd(16)} ${linha.n}`);
      }
    }

    const { rows: fonte } = await pool.query<{ n: string; customizados: string }>(
      `select count(*) filter (where is_custom = false)::text as n,
              count(*) filter (where is_custom)::text        as customizados
         from cfops`,
    );
    console.log(
      `\nFonte: ${fonte[0]?.n} CFOP(s) oficial(is)` +
        `, ${fonte[0]?.customizados} customizado(s) ignorado(s).`,
    );

    if (!executar) {
      console.log('\nSimulação. Use --executar para carregar.');
      return;
    }

    const { rowCount } = await pool.query(
      `insert into fiscal_codes (kind, code, description, valid_from, source)
       select 'cfop',
              c.code,
              c.description,
              $1::date,
              -- A procedência fica na linha, e não num comentário de migration:
              -- quem audita a validação pergunta de onde saiu o código, não de
              -- onde saiu a tabela.
              trim(coalesce(c.legal_basis, '') ||
                   case when c.sinief_article is null then '' else ', ' || c.sinief_article end)
         from cfops c
        where c.is_custom = false
          and c.code ~ '^[0-9]{4}$'
       on conflict (kind, code, valid_from) do update set
         description = excluded.description,
         source = excluded.source`,
      [VIGENTE_DESDE],
    );

    console.log(`\n${rowCount} CFOP(s) carregado(s).`);

    const { rows: depois } = await pool.query<{ kind: string; n: string }>(
      "select kind, count(*)::text as n from fiscal_codes group by kind order by kind",
    );
    for (const linha of depois) {
      console.log(`  ${linha.kind.padEnd(16)} ${linha.n}`);
    }

    console.log(
      '\nA partir daqui, CFOP fora da tabela oficial vira `unknown_code` na camada 3,\n' +
        'com severidade alta. Os outros tipos continuam `not_verified` — e continuam\n' +
        'devendo continuar, enquanto não houver fonte com procedência para eles.',
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
