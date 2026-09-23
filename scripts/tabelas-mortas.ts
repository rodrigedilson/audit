/**
 * Verifica — e opcionalmente remove — as tabelas órfãs de produção.
 *
 * Há tabelas no banco de produção que **nenhuma migration cria** e **nenhum
 * código referencia**: seis `interop_*` e `analysis_groups`. Elas apareceram num
 * levantamento anterior com zero linhas. Vieram de alguma feature planejada e
 * abandonada, provavelmente criada pelo painel do Supabase.
 *
 * O risco aqui não é apagar: é apagar **sem descobrir por que existiam**, e sem
 * confirmar que continuam vazias. Por isso este script é a etapa de evidência,
 * e não uma migration: ele imprime o que encontrou, recusa tocar em qualquer
 * tabela que tenha linha, view dependente ou chave estrangeira apontando para
 * ela, e só com `--executar` remove o que passou em todas as checagens.
 *
 * A migration com os nomes exatos é escrita **depois**, a partir da saída daqui.
 * Uma migration que apaga por padrão de nome surpreenderia quem vier depois.
 *
 * ```
 * npx tsx scripts/tabelas-mortas.ts
 * npx tsx scripts/tabelas-mortas.ts --executar
 * ```
 */
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

/** Padrões investigados. Não é lista de exclusão: é lista de suspeitas. */
const SUSPEITAS = ["relname like 'interop\\_%'", "relname = 'analysis_groups'"];

interface Candidata {
  tabela: string;
  linhas: number;
  tamanho: string;
  dependentes: string[];
  referenciada_por: string[];
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 20_000 });
  ignorarErroDeClienteOcioso(pool, 'TabelasMortasPool');

  try {
    const { rows: tabelas } = await pool.query<{ tabela: string; tamanho: string }>(
      `select c.relname as tabela,
              pg_size_pretty(pg_total_relation_size(c.oid)) as tamanho
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (${SUSPEITAS.map((s) => s.replace('relname', 'c.relname')).join(' or ')})
        order by c.relname`,
    );

    if (tabelas.length === 0) {
      console.log('Nenhuma das tabelas suspeitas existe neste banco. Nada a fazer.');
      return;
    }

    const candidatas: Candidata[] = [];

    for (const { tabela, tamanho } of tabelas) {
      // `count(*)` e não `n_live_tup`: a estatística do planejador fica velha, e
      // decidir apagar com número velho é o erro que este script existe para
      // não cometer.
      const { rows: contagem } = await pool.query<{ linhas: string }>(
        `select count(*)::text as linhas from public.${tabela}`,
      );

      const { rows: views } = await pool.query<{ nome: string }>(
        `select distinct dv.relname as nome
           from pg_depend d
           join pg_rewrite r on d.objid = r.oid
           join pg_class dv on r.ev_class = dv.oid
           join pg_class src on d.refobjid = src.oid
          where src.relname = $1 and dv.relname <> $1`,
        [tabela],
      );

      const { rows: fks } = await pool.query<{ nome: string }>(
        `select con.conrelid::regclass::text as nome
           from pg_constraint con
          where con.contype = 'f' and con.confrelid = $1::regclass`,
        [tabela],
      );

      candidatas.push({
        tabela,
        linhas: Number(contagem[0]?.linhas ?? 0),
        tamanho,
        dependentes: views.map((v) => v.nome),
        referenciada_por: fks.map((f) => f.nome),
      });
    }


    /**
     * FK de outra candidata é ordem, não impedimento.
     *
     * As sete tabelas formam uma hierarquia — `analysis_groups` ←
     * `interop_sessions` ← as outras quatro —, e tratar qualquer FK como
     * impedimento faria o script dizer "manter" justamente para as duas que são
     * o topo dela. Alguém leria isso como "essas duas são usadas", quando o que
     * as segura são tabelas igualmente mortas.
     *
     * FK de tabela **fora** do conjunto continua sendo impedimento de verdade:
     * ali há algo vivo apontando para cá.
     */
    const nomes = new Set(candidatas.map((c) => c.tabela));
    const impedimentoReal = (c: Candidata): string[] =>
      [
        c.linhas > 0 ? `${c.linhas} linha(s)` : null,
        c.dependentes.length > 0 ? `views: ${c.dependentes.join(', ')}` : null,
        ...c.referenciada_por
          .filter((origem) => !nomes.has(origem.replace(/^public\./, '')))
          .map((origem) => `FK de ${origem}, que está fora do conjunto`),
      ].filter((x): x is string => x !== null);

    const removiveis = candidatas.filter((c) => impedimentoReal(c).length === 0);
    const mantidas = candidatas.filter((c) => impedimentoReal(c).length > 0);

    /**
     * Ordem de remoção: quem é apontado sai depois de quem aponta.
     *
     * Sem ordenar, o `drop` da tabela-pai falha com violação de dependência — e
     * a alternativa, `cascade`, apagaria em silêncio o que o script existe para
     * conferir um por um.
     */
    const ordenadas: Candidata[] = [];
    const restantes = [...removiveis];
    while (restantes.length > 0) {
      const livre = restantes.findIndex((c) =>
        c.referenciada_por.every((origem) => {
          const nome = origem.replace(/^public\./, '');
          return !restantes.some((r) => r.tabela === nome) || nome === c.tabela;
        }),
      );

      if (livre === -1) {
        // Ciclo de FK entre as candidatas. Não deveria existir, e se existir é
        // caso para olhar à mão em vez de o script escolher por conta própria.
        console.error(
          '\nCiclo de chave estrangeira entre as candidatas: ' +
            restantes.map((r) => r.tabela).join(', '),
        );
        process.exitCode = 1;
        return;
      }

      ordenadas.push(restantes.splice(livre, 1)[0]!);
    }

    console.log('\nTabelas suspeitas encontradas:\n');
    for (const c of candidatas) {
      const impedimentos = impedimentoReal(c);
      const dentroDoConjunto = c.referenciada_por.filter((o) =>
        nomes.has(o.replace(/^public\./, '')),
      );

      console.log(
        `  ${c.tabela.padEnd(28)} ${c.tamanho.padStart(10)}  ` +
          (impedimentos.length === 0
            ? `vazia${dentroDoConjunto.length > 0 ? ` — sai depois de ${dentroDoConjunto.join(', ')}` : ' e sem dependência'}`
            : `MANTER — ${impedimentos.join(' · ')}`),
      );
    }

    console.log(`\n${removiveis.length} removível(is), ${mantidas.length} a manter.`);

    if (mantidas.length > 0) {
      console.log(
        '\nAs mantidas têm dado ou dependência: alguém as usou. A pergunta deixa de\n' +
          'ser "apagar" e passa a ser "de onde veio isso".',
      );
    }

    if (removiveis.length === 0) {
      return;
    }

    const sql = ordenadas.map((c) => `drop table if exists public.${c.tabela};`).join('\n');

    if (!executar) {
      console.log('\nSimulação. O que --executar rodaria, e o que vai para a migration:\n');
      console.log(sql);
      return;
    }

    const client = await pool.connect();
    try {
      // Uma transação para o conjunto: se uma falhar, nenhuma sai. Meia remoção
      // deixaria o banco num estado que nenhuma migration descreve.
      await client.query('begin');
      for (const c of ordenadas) {
        await client.query(`drop table if exists public.${c.tabela}`);
        console.log(`  removida ${c.tabela}`);
      }
      await client.query('commit');
    } catch (causa) {
      await client.query('rollback').catch(() => undefined);
      throw causa;
    } finally {
      client.release();
    }

    console.log('\nRemovidas. Registre em migration, com estes nomes:\n');
    console.log(sql);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
