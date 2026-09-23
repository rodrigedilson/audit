/**
 * Publica os prazos normativos em `deadline_rules`.
 *
 * `deadline_rules` nasce vazia, e lista vazia de prazos **não é** "nada a
 * vencer": `GET /v1/deadlines` devolve `normative_rules_loaded: false` para a
 * tela não ler o vazio como tranquilidade. Este script tira o produto desse
 * estado — para os prazos cuja norma foi conferida, e só para esses.
 *
 * **O que entra, e de onde:**
 *
 * - **EFD-Contribuições** — décimo dia útil do segundo mês subsequente, por
 *   IN RFB 1.252/2012, art. 7º. Aplica-se a quem apura PIS/Cofins pelos regimes
 *   cumulativo e não cumulativo; o Simples não entrega EFD-Contribuições.
 * - **DAS do Simples Nacional** — dia 20 do mês subsequente ao da receita
 *   bruta, antecipado para o dia útil anterior quando cai em fim de semana ou
 *   feriado, por LC 123/2006, art. 21.
 * - **PGDAS-D** — a declaração que gera o DAS, no mesmo dia 20, por Resolução
 *   CGSN 140/2018.
 *
 * **O que NÃO entra, e por quê.** A EFD ICMS/IPI tem prazo definido por
 * legislação estadual e varia por UF: um prazo único aqui estaria errado na
 * maioria dos estados, e prazo errado com base legal ao lado é pior que prazo
 * ausente. A janela de opção de regime do art. 40-D da LC 214/2025 também fica
 * de fora: o briefing deste projeto a cita a partir de terceiros, e o próprio
 * briefing registra que os números de terceiros não foram conferidos em texto
 * oficial.
 *
 * `severity` e `warn_days` **não são norma** — são escolha de produto sobre
 * quando alarmar, e por isso não aparecem na base legal de nenhuma linha.
 *
 * ```
 * npx tsx scripts/publicar-prazos-normativos.ts
 * npx tsx scripts/publicar-prazos-normativos.ts --executar
 * ```
 */
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

interface Prazo {
  ruleId: string;
  name: string;
  description: string;
  regimes: string[] | null;
  monthsAfter: number;
  dayOfMonth: number;
  dayRule: 'exact' | 'nth_business_day' | 'anticipate_to_business_day';
  warnDays: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  legalBasis: string;
}

const PRAZOS: readonly Prazo[] = [
  {
    ruleId: 'efd-contribuicoes',
    name: 'EFD-Contribuições',
    description:
      'Transmissão da escrituração de PIS/Pasep e Cofins ao Sped, até o décimo dia ' +
      'útil do segundo mês subsequente à competência.',
    // O Simples não entrega EFD-Contribuições.
    regimes: ['lucro_presumido', 'lucro_real'],
    monthsAfter: 2,
    dayOfMonth: 10,
    dayRule: 'nth_business_day',
    warnDays: 10,
    severity: 'high',
    legalBasis: 'IN RFB nº 1.252/2012, art. 7º',
  },
  {
    ruleId: 'das-simples-nacional',
    name: 'DAS do Simples Nacional',
    description:
      'Pagamento do Documento de Arrecadação do Simples Nacional, dia 20 do mês ' +
      'subsequente ao da receita bruta, antecipado para o dia útil anterior quando ' +
      'cai em fim de semana ou feriado.',
    regimes: ['mei', 'simples_integrado', 'simples_hibrido'],
    monthsAfter: 1,
    dayOfMonth: 20,
    dayRule: 'anticipate_to_business_day',
    warnDays: 7,
    severity: 'critical',
    legalBasis: 'LC nº 123/2006, art. 21',
  },
  {
    ruleId: 'pgdas-d',
    name: 'PGDAS-D',
    description:
      'Declaração mensal que apura os tributos do Simples e gera o DAS, no mesmo ' +
      'dia 20 do mês subsequente.',
    regimes: ['mei', 'simples_integrado', 'simples_hibrido'],
    monthsAfter: 1,
    dayOfMonth: 20,
    dayRule: 'anticipate_to_business_day',
    warnDays: 7,
    severity: 'high',
    legalBasis: 'Resolução CGSN nº 140/2018',
  },
];

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 30_000 });
  ignorarErroDeClienteOcioso(pool, 'PrazosPool');

  try {
    const { rows: coluna } = await pool.query<{ existe: boolean }>(
      `select exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'deadline_rules'
            and column_name = 'day_rule'
       ) as existe`,
    );

    if (coluna[0]?.existe !== true) {
      throw new Error(
        'A coluna `day_rule` não existe em deadline_rules. Aplique a migration\n' +
          '20260923100000_dia_util_nos_prazos.sql antes: sem ela, o décimo dia útil\n' +
          'entraria como dia 10 do calendário e o DAS não seria antecipado — data\n' +
          'errada ao lado de uma citação legal.',
      );
    }

    const { rows: antes } = await pool.query<{ n: string }>(
      'select count(*)::text as n from deadline_rules',
    );
    console.log(`deadline_rules agora: ${antes[0]?.n} regra(s).`);

    console.log('\nO que entra:');
    for (const p of PRAZOS) {
      console.log(
        `  ${p.ruleId.padEnd(22)} ${p.dayRule.padEnd(28)} ` +
          `+${p.monthsAfter}m dia ${p.dayOfMonth} · ${p.legalBasis}`,
      );
    }

    if (!executar) {
      console.log('\nSimulação. Use --executar para publicar.');
      return;
    }

    for (const p of PRAZOS) {
      await pool.query(
        `insert into deadline_rules (
           rule_id, name, description, nature, applies_to_regimes,
           months_after, day_of_month, day_rule, warn_days, severity, legal_basis
         ) values ($1, $2, $3, 'normativo', $4::regime[], $5, $6, $7, $8, $9, $10)
         on conflict (rule_id) do update set
           name = excluded.name,
           description = excluded.description,
           applies_to_regimes = excluded.applies_to_regimes,
           months_after = excluded.months_after,
           day_of_month = excluded.day_of_month,
           day_rule = excluded.day_rule,
           warn_days = excluded.warn_days,
           severity = excluded.severity,
           legal_basis = excluded.legal_basis`,
        [
          p.ruleId,
          p.name,
          p.description,
          p.regimes,
          p.monthsAfter,
          p.dayOfMonth,
          p.dayRule,
          p.warnDays,
          p.severity,
          p.legalBasis,
        ],
      );
      console.log(`  ✓ ${p.ruleId}`);
    }

    const { rows: depois } = await pool.query<{ n: string }>(
      'select count(*)::text as n from deadline_rules where active',
    );
    console.log(`\n${depois[0]?.n} regra(s) ativa(s).`);
    console.log(
      '\n`GET /v1/deadlines` passa a devolver `normative_rules_loaded: true`, e a tela\n' +
        'deixa de avisar que a lista vazia não era "nada a vencer". A EFD ICMS/IPI\n' +
        'continua fora: o prazo é estadual e varia por UF.',
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
