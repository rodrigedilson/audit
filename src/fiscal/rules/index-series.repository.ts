import type pg from 'pg';

import type { IndexPoint, IndexSeries } from '../forensics/calc/indices.js';

/**
 * Leitura das séries de índice.
 *
 * Carrega só o intervalo pedido, e não a série inteira: uma série de vinte anos
 * tem 240 pontos, e o cálculo típico usa uma dúzia. Buscar tudo para usar pouco
 * é o tipo de desperdício que só aparece quando a carteira cresce.
 */

export interface IndexSummary {
  indexId: string;
  name: string;
  source: string;
  verified: boolean;
  /** Quantos pontos a série tem. Zero significa catálogo sem dado. */
  pointCount: number;
  /** Competência mais antiga e mais recente. `null` quando não há ponto. */
  firstPeriod: string | null;
  lastPeriod: string | null;
}

export class IndexSeriesRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Catálogo com a cobertura de cada série.
   *
   * A cobertura é o que a tela precisa mostrar: uma série conferida e sem
   * pontos não corrige nada, e o escritório tem de ver isso antes de montar a
   * peça — não depois, com o cálculo devolvendo nulo.
   */
  async catalog(): Promise<IndexSummary[]> {
    const { rows } = await this.pool.query<{
      index_id: string;
      name: string;
      source: string;
      verified: boolean;
      point_count: string;
      first_period: string | null;
      last_period: string | null;
    }>(
      `select i.index_id, i.name, i.source, i.verified,
              count(p.period)::text as point_count,
              min(p.period)         as first_period,
              max(p.period)         as last_period
         from financial_indices i
         left join financial_index_points p on p.index_id = i.index_id
        group by i.index_id, i.name, i.source, i.verified
        order by i.index_id`,
    );

    return rows.map((r) => ({
      indexId: r.index_id,
      name: r.name,
      source: r.source,
      verified: r.verified,
      pointCount: Number(r.point_count),
      firstPeriod: r.first_period,
      lastPeriod: r.last_period,
    }));
  }

  /**
   * Carrega a série no intervalo `(from, to]`.
   *
   * O limite inferior é **exclusivo** porque é assim que se corrige: um valor de
   * janeiro sofre a variação de fevereiro em diante, e a de janeiro já está no
   * valor. Carregar o ponto de `from` faria `accumulateIndex` ignorá-lo, mas
   * traria um mês a mais em toda consulta sem necessidade.
   *
   * Devolve `null` quando o índice não existe no catálogo — distinto de existir
   * e não ter pontos, que devolve série vazia. A diferença importa: a primeira
   * é erro de digitação, a segunda é dado a carregar.
   */
  async load(indexId: string, from: string, to: string): Promise<IndexSeries | null> {
    const { rows: catalogo } = await this.pool.query<{
      index_id: string;
      name: string;
      source: string;
      verified: boolean;
    }>(
      `select index_id, name, source, verified from financial_indices where index_id = $1`,
      [indexId],
    );

    const cabecalho = catalogo[0];
    if (cabecalho === undefined) {
      return null;
    }

    const { rows: pontos } = await this.pool.query<{
      period: string;
      variation: string;
      level: string | null;
      source_ref: string | null;
    }>(
      `select period, variation::text, level::text, source_ref
         from financial_index_points
        where index_id = $1 and period > $2::char(7) and period <= $3::char(7)
        order by period`,
      [indexId, from, to],
    );

    const points: IndexPoint[] = pontos.map((p) => ({
      period: p.period,
      // `numeric` chega como string do driver, de propósito: converter no banco
      // perderia precisão antes de a aplicação ver o número.
      variation: Number(p.variation),
      level: p.level === null ? null : Number(p.level),
      sourceRef: p.source_ref,
    }));

    return {
      indexId: cabecalho.index_id,
      name: cabecalho.name,
      source: cabecalho.source,
      verified: cabecalho.verified,
      points,
    };
  }
}
