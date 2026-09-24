#!/usr/bin/env tsx
/**
 * Confere uma restauração de backup contra o banco de origem.
 *
 * Existe porque backup que ninguém restaurou é hipótese, não controle — é a
 * lacuna mais séria de `docs/seguranca/CONTROLES.md`, e a única cuja falha é
 * irreversível. Restaurar à mão e olhar se "parece certo" não fecha a lacuna:
 * o que fecha é uma comparação que uma auditoria possa repetir.
 *
 * A comparação aproveita o que este produto já tem de incomum: o log é
 * append-only e a sequência é densa por `(tenant_id, cnpj)`. Então um log
 * restaurado ou é **idêntico** ao de origem, evento por evento, ou está errado.
 * Não há meio-termo a interpretar.
 *
 * O que é conferido:
 *
 * 1. **Estrutura** — tabelas, funções, o gatilho append-only e o índice único de
 *    `event_id`. Restauração que perdeu o gatilho aceita `update` no log, e o
 *    banco deixa de ser trilha de defesa sem nenhum sintoma visível.
 * 2. **Fluxo de eventos por escopo** — contagem, último `event_seq` e um digest
 *    SHA-256 do fluxo inteiro em ordem. O digest é o que pega alteração de
 *    conteúdo que a contagem não vê.
 * 3. **Hash de projeção por escopo** — o mesmo hash que o produto mostra ao
 *    cliente e que `POST /verify` recalcula.
 *
 * Nada é escrito. As duas conexões abrem em transação somente-leitura.
 *
 * ```
 * ORIGEM_DATABASE_URL=… RESTAURADO_DATABASE_URL=… npx tsx scripts/conferir-restauracao.ts
 * ```
 */
import pg from 'pg';

interface Escopo {
  tenant_id: string;
  cnpj: string;
  eventos: number;
  ultimo_seq: number;
  digest: string;
}

interface Snapshot {
  tenant_id: string;
  cnpj: string;
  last_event_seq: number;
  projection_hash: string;
}

/** Objetos sem os quais o banco restaurado não é o mesmo banco. */
const FUNCOES = ['append_event', 'is_member_of', 'current_user_id'] as const;

/**
 * Digest do fluxo, calculado no servidor.
 *
 * `payload::text` é determinístico porque `jsonb` normaliza a ordem das chaves —
 * duas cópias fiéis produzem exatamente a mesma string. `order by event_seq`
 * dentro do `string_agg` é o que faz o digest detectar troca de ordem, e não só
 * troca de conteúdo.
 */
const SQL_ESCOPOS = `
  select tenant_id::text,
         cnpj,
         count(*)::int as eventos,
         max(event_seq)::int as ultimo_seq,
         encode(
           sha256(
             convert_to(
               string_agg(
                 event_seq || '|' || event_id || '|' || action || '|' || task_id || '|' ||
                 actor || '|' || coalesce(period, '') || '|' ||
                 to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF') || '|' ||
                 schema_version || '|' || payload::text,
                 chr(10) order by event_seq
               ),
               'UTF8'
             )
           ),
           'hex'
         ) as digest
    from events
   group by tenant_id, cnpj
   order by tenant_id, cnpj`;

const SQL_SNAPSHOTS = `
  select tenant_id::text, cnpj, last_event_seq::int, projection_hash
    from projection_snapshots
   order by tenant_id, cnpj`;

async function ler(url: string): Promise<{
  escopos: Escopo[];
  snapshots: Snapshot[];
  gatilho: boolean;
  indiceEventId: boolean;
  funcoes: string[];
}> {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });

  try {
    const client = await pool.connect();
    try {
      // Somente leitura declarada, e não por disciplina: um `update` acidental
      // num banco de produção durante uma conferência de desastre seria a ironia
      // mais cara possível.
      await client.query('begin read only');

      const escopos = await client.query<Escopo>(SQL_ESCOPOS);
      const snapshots = await client.query<Snapshot>(SQL_SNAPSHOTS);

      const gatilho = await client.query<{ existe: boolean }>(
        `select exists (
           select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
            where c.relname = 'events' and t.tgname = 'events_append_only'
              and not t.tgisinternal
         ) as existe`,
      );

      const indice = await client.query<{ existe: boolean }>(
        `select exists (
           select 1 from pg_indexes
            where schemaname = 'public' and indexname = 'events_event_id_key'
         ) as existe`,
      );

      const funcoes = await client.query<{ routine_name: string }>(
        `select routine_name from information_schema.routines
          where routine_schema = 'public' and routine_name = any($1::text[])`,
        [[...FUNCOES]],
      );

      await client.query('commit');

      return {
        escopos: escopos.rows,
        snapshots: snapshots.rows,
        gatilho: gatilho.rows[0]?.existe === true,
        indiceEventId: indice.rows[0]?.existe === true,
        funcoes: funcoes.rows.map((r) => r.routine_name).sort(),
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const chave = (e: { tenant_id: string; cnpj: string }): string => `${e.tenant_id}:${e.cnpj}`;

async function main(): Promise<void> {
  const origem = process.env['ORIGEM_DATABASE_URL'];
  const restaurado = process.env['RESTAURADO_DATABASE_URL'];

  if (origem === undefined || restaurado === undefined) {
    console.error(
      'Faltam ORIGEM_DATABASE_URL e RESTAURADO_DATABASE_URL.\n\n' +
        'A origem costuma ser produção e é lida em transação somente-leitura.\n' +
        'O restaurado é a cópia que você acabou de levantar do backup.',
    );
    process.exitCode = 1;
    return;
  }

  if (origem === restaurado) {
    console.error(
      'As duas URLs são a mesma. Comparar um banco consigo mesmo sempre passa, e ' +
        'passar assim seria pior do que não conferir: fecharia a lacuna no papel.',
    );
    process.exitCode = 1;
    return;
  }

  const [a, b] = await Promise.all([ler(origem), ler(restaurado)]);

  const problemas: string[] = [];

  // ------------------------------------------------------------ estrutura
  if (!b.gatilho) {
    problemas.push(
      'O gatilho `events_append_only` não existe no restaurado. Sem ele o log ' +
        'aceita `update` e deixa de ser trilha de defesa — e nada no produto avisa.',
    );
  }
  if (!b.indiceEventId) {
    problemas.push(
      'O índice único `events_event_id_key` não existe no restaurado. É a metade ' +
        'de INV-004 que garante `event_id` único.',
    );
  }
  const funcoesFaltando = a.funcoes.filter((f) => !b.funcoes.includes(f));
  if (funcoesFaltando.length > 0) {
    problemas.push(`Funções ausentes no restaurado: ${funcoesFaltando.join(', ')}.`);
  }

  // ------------------------------------------------------- fluxo por escopo
  const mapaB = new Map(b.escopos.map((e) => [chave(e), e]));
  let iguais = 0;

  for (const esperado of a.escopos) {
    const obtido = mapaB.get(chave(esperado));

    if (obtido === undefined) {
      problemas.push(`Escopo ${chave(esperado)} não existe no restaurado.`);
      continue;
    }

    mapaB.delete(chave(esperado));

    if (obtido.digest === esperado.digest) {
      iguais += 1;
      continue;
    }

    problemas.push(
      `Escopo ${chave(esperado)}: o fluxo de eventos difere. ` +
        `Origem ${esperado.eventos} evento(s) até seq ${esperado.ultimo_seq}; ` +
        `restaurado ${obtido.eventos} até seq ${obtido.ultimo_seq}.` +
        (obtido.eventos === esperado.eventos
          ? ' A contagem bate e o conteúdo não — é alteração, não perda.'
          : ''),
    );
  }

  for (const sobrando of mapaB.values()) {
    problemas.push(
      `Escopo ${chave(sobrando)} existe no restaurado e não na origem. ` +
        'Backup de outro momento, ou de outro projeto.',
    );
  }

  // --------------------------------------------------------- hash de projeção
  const snapsB = new Map(b.snapshots.map((s) => [chave(s), s]));
  for (const esperado of a.snapshots) {
    const obtido = snapsB.get(chave(esperado));

    if (obtido === undefined) {
      problemas.push(`Sem snapshot de projeção para ${chave(esperado)} no restaurado.`);
    } else if (obtido.projection_hash !== esperado.projection_hash) {
      problemas.push(
        `Escopo ${chave(esperado)}: o hash da projeção difere. É o mesmo hash que ` +
          'o cliente vê na tela e que `POST /verify` recalcula.',
      );
    }
  }

  // ------------------------------------------------------------- resultado
  console.log(`Origem:     ${a.escopos.length} escopo(s), ${a.snapshots.length} snapshot(s)`);
  console.log(`Restaurado: ${b.escopos.length} escopo(s), ${b.snapshots.length} snapshot(s)`);
  console.log(`Fluxos idênticos: ${iguais} de ${a.escopos.length}`);

  if (a.escopos.length === 0) {
    console.log(
      '\nA origem não tem nenhum evento. A conferência passou sem comparar nada — ' +
        'o que NÃO é o mesmo que backup verificado. Refaça com dados.',
    );
    process.exitCode = 1;
    return;
  }

  if (problemas.length === 0) {
    console.log('\nRestauração fiel: estrutura, fluxo de eventos e hash de projeção conferem.');
    return;
  }

  console.error(`\n${problemas.length} problema(s):`);
  for (const p of problemas) {
    console.error(`  - ${p}`);
  }
  process.exitCode = 1;
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
