/**
 * Séries de índice e o fator acumulado entre duas competências.
 *
 * Toda correção monetária num laudo precisa dizer **qual índice, qual período e
 * qual fonte** — sem isso o número não é conferível, e a parte contrária pede
 * esclarecimento antes de discutir o mérito. É por isso que o resultado carrega
 * a série usada, e não só o valor.
 *
 * As séries **nascem vazias**. IPCA, INPC, IGP-M, TR e SELIC têm publicação
 * mensal oficial que ninguém carregou ainda, e índice errado numa memória que
 * vai ao juízo é pior do que memória ausente. Sem a série, o fator sai `null`
 * com o motivo — nunca 1, que se leria como "não houve inflação no período".
 */

export interface IndexPoint {
  /** Competência `YYYY-MM`. */
  period: string;
  /**
   * Variação do mês como **fração**: `0.0042` é 0,42%.
   *
   * Nunca percentual inteiro. A fonte publica "0,42%", e guardar 0.42 faria a
   * correção de um ano render 4.200% — erro que passa despercebido num teste
   * de um mês só.
   */
  variation: number;
  /** Número-índice, quando a fonte publica. Informativo. */
  level: number | null;
  /** Identificação do dado conferido: URL, número da tabela, data de coleta. */
  sourceRef: string | null;
}

export interface IndexSeries {
  /** `ipca`, `inpc`, `igpm`, `tr`, `selic`, `tjsp`. */
  indexId: string;
  name: string;
  /** Quem publica: IBGE, FGV, BCB, TJSP. */
  source: string;
  /** Conferida na fonte oficial? Enquanto `false`, o cálculo não afirma. */
  verified: boolean;
  /** Ordem significativa: crescente por competência. */
  points: readonly IndexPoint[];
}

export interface AppliedIndex {
  indexId: string;
  /** Competência inicial, exclusiva: corrige-se **a partir** dela. */
  from: string;
  /** Competência final, inclusiva. */
  to: string;
  /**
   * Fator acumulado. `null` quando a série não cobre o intervalo inteiro.
   *
   * Cobrir "quase todo" o intervalo não serve: um mês faltando no meio produz
   * um fator menor que o real, e o laudo pediria menos do que é devido sem
   * que ninguém percebesse.
   */
  factor: number | null;
  /** Meses efetivamente aplicados. */
  months: number;
  /** Obrigatório quando `factor` é `null`. */
  unavailableReason: string | null;
  /** Fonte da série, para ir impressa ao lado do número. */
  source: string;
  verified: boolean;
}

/** `YYYY-MM` → índice absoluto em meses, para comparar e contar. */
function emMeses(period: string): number {
  const [ano, mes] = period.split('-').map(Number) as [number, number];
  return ano * 12 + (mes - 1);
}

function indisponivel(
  series: IndexSeries | null,
  indexId: string,
  from: string,
  to: string,
  reason: string,
): AppliedIndex {
  return {
    indexId,
    from,
    to,
    factor: null,
    months: 0,
    unavailableReason: reason,
    source: series?.source ?? '',
    verified: series?.verified ?? false,
  };
}

/**
 * Fator acumulado de `from` (exclusivo) até `to` (inclusivo).
 *
 * O intervalo é meio-aberto porque é assim que se corrige: um valor de
 * janeiro corrigido até março sofre a variação de fevereiro e a de março, e
 * não a de janeiro — a de janeiro já está no valor.
 */
export function accumulateIndex(
  series: IndexSeries | null,
  from: string,
  to: string,
  indexId = series?.indexId ?? '',
): AppliedIndex {
  if (series === null) {
    return indisponivel(
      null,
      indexId,
      from,
      to,
      `A série '${indexId}' não está carregada.`,
    );
  }

  const inicio = emMeses(from);
  const fim = emMeses(to);

  if (fim < inicio) {
    return indisponivel(
      series,
      series.indexId,
      from,
      to,
      'A competência final é anterior à inicial.',
    );
  }

  if (fim === inicio) {
    // Mesma competência não sofre correção, e isso é resposta, não lacuna.
    return {
      indexId: series.indexId,
      from,
      to,
      factor: 1,
      months: 0,
      unavailableReason: null,
      source: series.source,
      verified: series.verified,
    };
  }

  const porCompetencia = new Map(series.points.map((p) => [p.period, p]));
  const faltando: string[] = [];
  let fator = 1;
  let meses = 0;

  for (let m = inicio + 1; m <= fim; m += 1) {
    const period = `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
    const ponto = porCompetencia.get(period);

    if (ponto === undefined) {
      faltando.push(period);
      continue;
    }

    fator *= 1 + ponto.variation;
    meses += 1;
  }

  if (faltando.length > 0) {
    return indisponivel(
      series,
      series.indexId,
      from,
      to,
      `A série não cobre ${faltando.length} competência(s) do intervalo: ` +
        `${faltando.slice(0, 6).join(', ')}${faltando.length > 6 ? '…' : ''}. ` +
        'Um mês faltando produziria fator menor que o real.',
    );
  }

  return {
    indexId: series.indexId,
    from,
    to,
    factor: fator,
    months: meses,
    unavailableReason: null,
    source: series.source,
    verified: series.verified,
  };
}

/**
 * A série cobre o intervalo?
 *
 * Existe separada de `accumulateIndex` porque a tela precisa saber **antes** de
 * pedir o cálculo, para dizer o que falta carregar em vez de mostrar um erro
 * depois de o perito montar a peça.
 */
export function cobreIntervalo(series: IndexSeries | null, from: string, to: string): boolean {
  return accumulateIndex(series, from, to).factor !== null;
}
