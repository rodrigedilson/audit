import type pg from 'pg';

import {
  INDEX_SOURCES,
  IndexSourceError,
  conferirFontes,
  lerSgs,
  lerSidra,
  rotuloDaFonte,
  urlDaFonte,
  type IndexSourceSpec,
  type OfficialPoint,
  type SourceRef,
} from './index-sources.js';

/**
 * Carga das séries de índice a partir das fontes oficiais.
 *
 * **Conferência automática, quando as fontes batem** (decisão de 25/09/2026):
 * IPCA e INPC saem do IBGE e são conferidos, mês a mês, contra a republicação
 * do BCB; IGP-M, TR e SELIC saem direto da API oficial do BCB. A série fica
 * `verified = true` quando a conferência passa, e `false` com os meses
 * divergentes quando não passa. `verified_by` fica nulo: quem conferiu foi a
 * comparação entre as fontes, e o `source_ref` diz quais e quando.
 *
 * A mesma função serve o script (`scripts/carregar-indices-oficiais.ts`) e o
 * agendador diário do processo da API.
 */

/** Resposta crua de uma consulta: o carregador interpreta, o transporte não. */
export interface HttpJson {
  status: number;
  json: unknown;
}

export type FetchJson = (url: string) => Promise<HttpJson>;

export interface LoadOptions {
  pool: pg.Pool;
  fetchJson: FetchJson;
  now: Date;
  /** Primeira competência a buscar. */
  desde: string;
  /** Índices a carregar; sem a opção, todos os do catálogo de fontes. */
  indices?: readonly string[];
  /** Sem isto, só relata: nada é gravado. */
  executar: boolean;
}

export interface IndexLoadReport {
  indexId: string;
  points: number;
  firstPeriod: string | null;
  lastPeriod: string | null;
  /** Competências que ainda não estavam no banco. */
  inserted: number;
  /** Competências já gravadas cujo valor a fonte mudou. */
  revisions: { period: string; before: number; after: number }[];
  verified: boolean;
  /** Por que não ficou conferida, quando não ficou. */
  notVerifiedReason: string | null;
  sourceRef: string;
}

/**
 * Pedidos em janelas de cinco anos. O SGS é instável com janela longa: em
 * 25/09/2026, 1994–2003 da SELIC levou 30 s e voltou uma página HTML de
 * "Requisição inválida!" com status 200, e 1994–1998 voltou certo em 3 s.
 */
const ANOS_POR_PEDIDO = 5;

function ultimaFechada(now: Date): string {
  const local = new Date(now.getTime() - 3 * 3600_000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function janelas(desde: string, ate: string): [string, string][] {
  const resultado: [string, string][] = [];
  let ano = Number(desde.slice(0, 4));
  const anoFinal = Number(ate.slice(0, 4));
  let inicio = desde;
  while (ano <= anoFinal) {
    const fimAno = Math.min(ano + ANOS_POR_PEDIDO - 1, anoFinal);
    const fim = fimAno === anoFinal ? ate : `${fimAno}-12`;
    resultado.push([inicio, fim]);
    ano = fimAno + 1;
    inicio = `${ano}-01`;
  }
  return resultado;
}

async function buscar(
  fetchJson: FetchJson,
  ref: SourceRef,
  desde: string,
  ate: string,
  now: Date,
): Promise<OfficialPoint[]> {
  const pontos: OfficialPoint[] = [];
  for (const [inicio, fim] of janelas(desde, ate)) {
    const url = urlDaFonte(ref, inicio, fim);
    const resposta = await fetchJson(url);
    // O SGS responde 404 "Value(s) not found" para janela sem dado: é série
    // vazia naquele trecho, e não falha da fonte.
    if (ref.kind === 'sgs' && resposta.status === 404) continue;
    if (resposta.status < 200 || resposta.status >= 300) {
      throw new IndexSourceError(`${rotuloDaFonte(ref)} respondeu ${resposta.status} em ${url}.`);
    }
    pontos.push(...(ref.kind === 'sgs' ? lerSgs(resposta.json, now) : lerSidra(resposta.json, now)));
  }
  return pontos;
}

async function carregarUm(spec: IndexSourceSpec, options: LoadOptions): Promise<IndexLoadReport> {
  const { pool, fetchJson, now, desde, executar } = options;
  const ate = ultimaFechada(now);
  const coleta = now.toISOString().slice(0, 10);

  const primario = await buscar(fetchJson, spec.primary, desde, ate, now);
  const rotulos = [rotuloDaFonte(spec.primary)];

  let verified = primario.length > 0;
  let notVerifiedReason: string | null = verified ? null : 'A fonte não trouxe nenhuma competência.';

  if (spec.crossCheck !== null && primario.length > 0) {
    const segundo = await buscar(fetchJson, spec.crossCheck, desde, ate, now);
    rotulos.push(`conferido contra ${rotuloDaFonte(spec.crossCheck)}`);
    const conferencia = conferirFontes(primario, segundo);
    if (conferencia.compared === 0) {
      verified = false;
      notVerifiedReason = 'As duas fontes não têm nenhuma competência em comum para conferir.';
    } else if (conferencia.divergences.length > 0) {
      verified = false;
      notVerifiedReason =
        `As fontes divergem em ${conferencia.divergences.length} competência(s): ` +
        conferencia.divergences
          .slice(0, 6)
          .map((d) => `${d.period} (${(d.primary * 100).toFixed(2)}% × ${(d.crossCheck * 100).toFixed(2)}%)`)
          .join(', ') +
        (conferencia.divergences.length > 6 ? '…' : '');
    }
  }

  const sourceRef = `${rotulos.join(', ')}; coleta em ${coleta}`;

  const { rows: gravados } = await pool.query<{ period: string; variation: string }>(
    'select period, variation::text from financial_index_points where index_id = $1',
    [spec.indexId],
  );
  const antes = new Map(gravados.map((r) => [r.period, Number(r.variation)]));
  const revisions = primario
    .filter((p) => antes.has(p.period) && Math.abs(antes.get(p.period)! - p.variation) > 1e-12)
    .map((p) => ({ period: p.period, before: antes.get(p.period)!, after: p.variation }));
  const inserted = primario.filter((p) => !antes.has(p.period)).length;

  if (executar && primario.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (let i = 0; i < primario.length; i += 500) {
        const lote = primario.slice(i, i + 500);
        const valores: unknown[] = [];
        const marcadores = lote.map((p, j) => {
          valores.push(spec.indexId, p.period, p.variation, sourceRef);
          const b = j * 4;
          return `($${b + 1}, $${b + 2}::char(7), $${b + 3}::numeric, $${b + 4})`;
        });
        await client.query(
          `insert into financial_index_points (index_id, period, variation, source_ref)
           values ${marcadores.join(', ')}
           on conflict (index_id, period) do update
             set variation = excluded.variation, source_ref = excluded.source_ref, loaded_at = now()`,
          valores,
        );
      }
      // A conferência mais recente decide: série que deixou de bater volta a
      // não conferida, e o cálculo para de afirmar.
      await client.query(
        `update financial_indices
            set verified = $2, source_ref = $3, verified_by = null,
                verified_at = case when $2 then now() else null end
          where index_id = $1`,
        [spec.indexId, verified, sourceRef],
      );
      await client.query('commit');
    } catch (erro) {
      await client.query('rollback').catch(() => undefined);
      throw erro;
    } finally {
      client.release();
    }
  }

  return {
    indexId: spec.indexId,
    points: primario.length,
    firstPeriod: primario[0]?.period ?? null,
    lastPeriod: primario.at(-1)?.period ?? null,
    inserted,
    revisions,
    verified,
    notVerifiedReason,
    sourceRef,
  };
}

/** Carrega os índices pedidos, um de cada vez, cada um na própria transação. */
export async function carregarIndices(options: LoadOptions): Promise<IndexLoadReport[]> {
  const pedidos = options.indices;
  const specs =
    pedidos === undefined || pedidos.length === 0
      ? INDEX_SOURCES
      : INDEX_SOURCES.filter((s) => pedidos.includes(s.indexId));
  if (pedidos !== undefined && specs.length !== pedidos.length) {
    const conhecidos = INDEX_SOURCES.map((s) => s.indexId);
    throw new IndexSourceError(
      `Índice sem fonte oficial cadastrada: ${pedidos.filter((p) => !conhecidos.includes(p)).join(', ')}. ` +
        `Conhecidos: ${conhecidos.join(', ')}.`,
    );
  }

  const relatorios: IndexLoadReport[] = [];
  for (const spec of specs) {
    relatorios.push(await carregarUm(spec, options));
  }
  return relatorios;
}

/**
 * Transporte padrão: `fetch` com timeout e quatro tentativas, espera crescente.
 *
 * Repete 5xx, timeout e **corpo que não é JSON**: o SGS às vezes responde uma
 * página HTML de erro com status 200, e lê-la como série daria "não é uma
 * lista" sem tentar de novo. 4xx não é repetido — a resposta não muda —, e o
 * 404 do SGS chega ao carregador, que o lê como janela vazia.
 */
export function fetchJsonComTentativas(tentativas = 4, timeoutMs = 60_000): FetchJson {
  return async (url) => {
    let ultimo: unknown;
    for (let i = 0; i < tentativas; i += 1) {
      try {
        const resposta = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (resposta.status >= 500) throw new IndexSourceError(`${url} respondeu ${resposta.status}.`);
        const corpo = await resposta.text();
        if (resposta.status === 404) return { status: 404, json: null };
        let json: unknown;
        try {
          json = JSON.parse(corpo);
        } catch {
          throw new IndexSourceError(`${url} respondeu algo que não é JSON: ${corpo.slice(0, 80)}`);
        }
        return { status: resposta.status, json };
      } catch (erro) {
        ultimo = erro;
        if (i < tentativas - 1) await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
      }
    }
    throw ultimo instanceof Error ? ultimo : new IndexSourceError(`Falha ao consultar ${url}.`);
  };
}

/**
 * Precisa buscar? Só quando alguma série do catálogo de fontes está vazia ou
 * tem o último ponto anterior à última competência fechada. É o que o
 * agendador diário pergunta antes de ir à rede.
 */
export async function indicesDesatualizados(pool: pg.Pool, now: Date): Promise<boolean> {
  const { rows } = await pool.query<{ index_id: string; ultimo: string | null }>(
    `select i.index_id, max(p.period) as ultimo
       from financial_indices i
       left join financial_index_points p on p.index_id = i.index_id
      where i.index_id = any($1::text[])
      group by i.index_id`,
    [INDEX_SOURCES.map((s) => s.indexId)],
  );
  const alvo = ultimaFechada(now);
  return rows.length < INDEX_SOURCES.length || rows.some((r) => r.ultimo === null || r.ultimo < alvo);
}

/** Um dia: o índice é mensal, e a fonte publica perto do dia 10. */
const INTERVALO_DO_AGENDADOR = 24 * 3600_000;

/** Revisões recentes: a fonte pode corrigir os últimos meses já publicados. */
const MESES_DE_REVISAO = 12;

export interface IndicesScheduler {
  stop(): Promise<void>;
}

/**
 * Atualização diária das séries, no processo da API e só com `startWorkers`.
 *
 * Só vai à rede quando alguma série está atrasada, e então busca os últimos
 * doze meses — o bastante para pegar o mês novo e uma revisão da fonte, sem
 * baixar trinta anos todo dia. Série vazia busca desde `desde`.
 */
export function startIndicesScheduler(
  pool: pg.Pool,
  options: {
    fetchJson?: FetchJson;
    now?: () => Date;
    intervalMs?: number;
    desde?: string;
    onError?: (erro: unknown) => void;
    onLoad?: (relatorios: IndexLoadReport[]) => void;
  } = {},
): IndicesScheduler {
  const intervalo = options.intervalMs ?? INTERVALO_DO_AGENDADOR;
  const agora = options.now ?? (() => new Date());
  const fetchJson = options.fetchJson ?? fetchJsonComTentativas();
  let parar = false;
  let emCurso: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const tique = async (): Promise<void> => {
    const now = agora();
    if (!(await indicesDesatualizados(pool, now))) return;
    const { rows } = await pool.query<{ ultimo: string | null }>(
      'select min(ultimo) as ultimo from (select max(period) as ultimo from financial_index_points group by index_id) s',
    );
    const vazio = (await pool.query<{ n: string }>('select count(distinct index_id)::text n from financial_index_points'))
      .rows[0]!.n;
    const desde =
      rows[0]?.ultimo == null || Number(vazio) < INDEX_SOURCES.length
        ? (options.desde ?? '1994-07')
        : recuar(rows[0].ultimo, MESES_DE_REVISAO);
    options.onLoad?.(await carregarIndices({ pool, fetchJson, now, desde, executar: true }));
  };

  const agendar = (): void => {
    if (parar) return;
    timer = setTimeout(() => {
      emCurso = tique()
        .catch((erro) => options.onError?.(erro))
        .finally(agendar);
    }, intervalo);
    timer.unref();
  };

  agendar();

  return {
    async stop() {
      parar = true;
      if (timer !== undefined) clearTimeout(timer);
      await emCurso;
    },
  };
}

function recuar(period: string, meses: number): string {
  const [ano, mes] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(ano, mes - 1 - meses, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
