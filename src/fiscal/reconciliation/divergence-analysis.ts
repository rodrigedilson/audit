/**
 * Contra-apuração: a nossa apuração contra a proposta do Fisco, nota a nota.
 *
 * A apuração assistida inverte o ônus da prova — o Fisco propõe o número e o
 * silêncio vale como concordância. Discordar exige dizer **onde** e **por quê**,
 * e é isso que este módulo produz: uma causa provável nomeada por divergência,
 * não um total que não fecha.
 *
 * Puro de propósito: a comparação é a peça que o contador leva para contestar, e
 * precisa ser reproduzível a partir das duas listas de entrada, sem banco no
 * meio.
 */

export type Direction = 'inbound' | 'outbound';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type DivergenceScope = 'tributo' | 'documento' | 'item';

/**
 * Causas prováveis, e não diagnósticos.
 *
 * O sistema vê duas listas de números; a razão real pode ser erro nosso, erro do
 * Fisco, documento cancelado ou nota que ainda não foi processada pelos dois
 * lados. Nomear a hipótese ajuda a investigar; afirmá-la como conclusão faria o
 * contador contestar com base errada.
 */
export type ProbableCause =
  /** Mesma base, alíquota diferente. */
  | 'aliquota_divergente'
  /** Mesma alíquota, base diferente. */
  | 'base_divergente'
  | 'base_e_aliquota_divergentes'
  /**
   * Base e alíquota conferem e o valor não. A aritmética de um dos dois lados
   * não fecha — é o caso em que vale conferir o arredondamento do emitente.
   */
  | 'valor_incoerente_com_base_e_aliquota'
  /**
   * Saída que o Fisco aponta e não escrituramos. **Exposição**: é débito que
   * será cobrado.
   */
  | 'debito_nao_escriturado'
  /**
   * Entrada que o Fisco aponta e não aproveitamos. **Perda**: crédito que o
   * próprio Fisco reconhece e está sendo deixado na mesa.
   */
  | 'credito_nao_aproveitado'
  /** Saída que escrituramos e o Fisco não aponta. */
  | 'debito_nao_reconhecido_pelo_fisco'
  /**
   * Entrada que escrituramos e o Fisco não aponta. **Glosa**: o crédito
   * aproveitado tende a ser negado, e é a divergência mais cara da lista.
   */
  | 'credito_glosado'
  /** Diferença dentro da tolerância, somada por tributo. */
  | 'arredondamento'
  /** Diferença no total por tributo que as linhas não explicam. */
  | 'total_nao_explicado_pelas_linhas'
  /** Honesto: há diferença e o padrão não corresponde a nenhuma hipótese acima. */
  | 'causa_nao_determinada';

export interface ComparableLine {
  accessKey: string;
  line: number;
  tax: string;
  direction: Direction;
  baseCents: number;
  rate: number;
  amountCents: number;
}

export interface Divergence {
  scope: DivergenceScope;
  subject: string;
  tax: string;
  direction: Direction | null;
  accessKey: string | null;
  line: number | null;
  ourCents: number;
  fiscoCents: number;
  /** Fisco menos nosso. Positivo = o Fisco aponta mais do que escrituramos. */
  differenceCents: number;
  probableCause: ProbableCause;
  severity: Severity;
}

export interface ComparisonInput {
  ours: readonly ComparableLine[];
  fisco: readonly ComparableLine[];
  /** Totais por tributo declarados pelo Fisco, quando a proposta os traz. */
  fiscoTotals?: Readonly<Record<string, number>>;
  /**
   * `false` quando a proposta veio só com totais.
   *
   * Sem detalhe, a comparação nota a nota não acontece. O resultado tem de dizer
   * isso: reportar zero divergências de item seria lido como "confere".
   */
  lineLevel: boolean;
  /** Tolerância por linha, em centavos. Acima dela a diferença é divergência. */
  toleranceCents?: number;
}

export interface ComparisonSummary {
  divergencesCount: number;
  /**
   * Débito que o Fisco aponta e não escrituramos. É o que será cobrado.
   *
   * Separado de `creditLossCents` de propósito: somar os dois num "líquido"
   * permitiria a um milhão de exposição e um milhão de perda se cancelarem na
   * tela, e o escritório concluir que está tudo certo.
   */
  exposureCents: number;
  /** Crédito que o Fisco reconhece e não aproveitamos. É dinheiro na mesa. */
  creditLossCents: number;
  /** Crédito nosso que o Fisco não reconhece: tende a ser glosado. */
  creditAtRiskCents: number;
  bySeverity: Record<Severity, number>;
  /** Linhas comparadas de fato. Zero com proposta só de totais. */
  linesCompared: number;
  lineLevel: boolean;
}

export interface ComparisonResult {
  divergences: Divergence[];
  summary: ComparisonSummary;
}

/** Um centavo por linha: abaixo disso é arredondamento do emitente, não divergência. */
export const TOLERANCIA_PADRAO_CENTAVOS = 1;

/** Limite de divergências de item no resultado; o total do resumo continua exato. */
export const MAX_DIVERGENCIAS_DE_ITEM = 500;

export function compare(input: ComparisonInput): ComparisonResult {
  const tolerancia = input.toleranceCents ?? TOLERANCIA_PADRAO_CENTAVOS;

  const nossas = indexar(input.ours);
  const doFisco = indexar(input.fisco);

  const divergencias: Divergence[] = [];
  const arredondamentos = new Map<string, number>();

  if (input.lineLevel) {
    divergencias.push(
      ...compararLinhas(nossas, doFisco, tolerancia, arredondamentos),
      ...somenteDeUmLado(doFisco, nossas, input.ours, 'fisco'),
      ...somenteDeUmLado(nossas, doFisco, input.fisco, 'nosso'),
    );
  }

  divergencias.push(...deArredondamento(arredondamentos));
  divergencias.push(...porTributo(input, divergencias));

  const ordenadas = divergencias.sort(ordenarPorGravidade);

  return {
    divergences: cortarItens(ordenadas),
    summary: resumir(ordenadas, input),
  };
}

// ------------------------------------------------------------ comparação

function chave(linha: ComparableLine): string {
  return `${linha.accessKey}#${linha.line}#${linha.tax}`;
}

function indexar(linhas: readonly ComparableLine[]): Map<string, ComparableLine> {
  const mapa = new Map<string, ComparableLine>();
  for (const linha of linhas) {
    mapa.set(chave(linha), linha);
  }
  return mapa;
}

function compararLinhas(
  nossas: Map<string, ComparableLine>,
  doFisco: Map<string, ComparableLine>,
  tolerancia: number,
  arredondamentos: Map<string, number>,
): Divergence[] {
  const saida: Divergence[] = [];

  for (const [id, nossa] of nossas) {
    const deles = doFisco.get(id);
    if (!deles) {
      continue;
    }

    const diferenca = deles.amountCents - nossa.amountCents;
    if (diferenca === 0) {
      continue;
    }

    if (Math.abs(diferenca) <= tolerancia) {
      // Somado por tributo em vez de uma divergência por linha: mil linhas com
      // um centavo de diferença viram mil itens que ninguém lê e escondem a
      // divergência que importa.
      arredondamentos.set(nossa.tax, (arredondamentos.get(nossa.tax) ?? 0) + diferenca);
      continue;
    }

    saida.push({
      scope: 'item',
      subject: `${nossa.accessKey}#${nossa.line}`,
      tax: nossa.tax,
      direction: nossa.direction,
      accessKey: nossa.accessKey,
      line: nossa.line,
      ourCents: nossa.amountCents,
      fiscoCents: deles.amountCents,
      differenceCents: diferenca,
      probableCause: causaDaDiferenca(nossa, deles),
      severity: 'high',
    });
  }

  return saida;
}

/**
 * A hipótese sai do padrão dos três números, e não do valor da diferença.
 * Alíquota divergente e base divergente levam a contestações diferentes: a
 * primeira discute enquadramento, a segunda discute o documento.
 */
function causaDaDiferenca(nossa: ComparableLine, deles: ComparableLine): ProbableCause {
  const mesmaBase = nossa.baseCents === deles.baseCents;
  const mesmaAliquota = Math.abs(nossa.rate - deles.rate) < 0.0001;

  if (mesmaBase && !mesmaAliquota) {
    return 'aliquota_divergente';
  }
  if (!mesmaBase && mesmaAliquota) {
    return 'base_divergente';
  }
  if (!mesmaBase && !mesmaAliquota) {
    return 'base_e_aliquota_divergentes';
  }
  return 'valor_incoerente_com_base_e_aliquota';
}

/**
 * Linhas presentes num lado e ausentes no outro.
 *
 * O sentido da operação decide o significado, e é por isso que não existe um
 * único motivo "linha ausente": uma saída que só o Fisco vê é débito que será
 * cobrado; uma entrada que só nós vemos é crédito que tende a ser glosado. São
 * dois problemas de naturezas opostas.
 */
function somenteDeUmLado(
  origem: Map<string, ComparableLine>,
  outro: Map<string, ComparableLine>,
  linhasDoOutro: readonly ComparableLine[],
  lado: 'fisco' | 'nosso',
): Divergence[] {
  const chavesDoOutro = new Set(linhasDoOutro.map((l) => l.accessKey));
  const saida: Divergence[] = [];

  for (const [id, linha] of origem) {
    if (outro.has(id)) {
      continue;
    }

    // Documento inteiro ausente é achado diferente de item ausente num
    // documento que os dois lados conhecem.
    const documentoInteiro = !chavesDoOutro.has(linha.accessKey);
    const causa = causaDaAusencia(linha.direction, lado);

    saida.push({
      scope: documentoInteiro ? 'documento' : 'item',
      subject: documentoInteiro ? linha.accessKey : `${linha.accessKey}#${linha.line}`,
      tax: linha.tax,
      direction: linha.direction,
      accessKey: linha.accessKey,
      line: documentoInteiro ? null : linha.line,
      ourCents: lado === 'fisco' ? 0 : linha.amountCents,
      fiscoCents: lado === 'fisco' ? linha.amountCents : 0,
      differenceCents: lado === 'fisco' ? linha.amountCents : -linha.amountCents,
      probableCause: causa,
      severity: gravidadeDaAusencia(causa),
    });
  }

  return saida;
}

function causaDaAusencia(direction: Direction, lado: 'fisco' | 'nosso'): ProbableCause {
  if (lado === 'fisco') {
    return direction === 'outbound' ? 'debito_nao_escriturado' : 'credito_nao_aproveitado';
  }
  return direction === 'outbound' ? 'debito_nao_reconhecido_pelo_fisco' : 'credito_glosado';
}

function gravidadeDaAusencia(causa: ProbableCause): Severity {
  switch (causa) {
    // Débito que o Fisco cobrará e crédito que ele negará: os dois custam
    // dinheiro em caixa, e é onde o silêncio sai mais caro.
    case 'debito_nao_escriturado':
    case 'credito_glosado':
      return 'critical';
    case 'credito_nao_aproveitado':
      return 'high';
    default:
      return 'medium';
  }
}

function deArredondamento(arredondamentos: Map<string, number>): Divergence[] {
  const saida: Divergence[] = [];

  for (const [tributo, soma] of arredondamentos) {
    if (soma === 0) {
      continue;
    }

    saida.push({
      scope: 'tributo',
      subject: tributo,
      tax: tributo,
      direction: null,
      accessKey: null,
      line: null,
      ourCents: 0,
      fiscoCents: 0,
      differenceCents: soma,
      probableCause: 'arredondamento',
      severity: 'low',
    });
  }

  return saida;
}

/**
 * Divergência de total por tributo.
 *
 * Com a proposta só de totais é o único achado possível — e é justamente por
 * isso que ele tem de existir: sem ele um upload sem detalhe sairia com zero
 * divergências, que se lê como "confere".
 */
function porTributo(input: ComparisonInput, deLinhas: readonly Divergence[]): Divergence[] {
  if (!input.fiscoTotals) {
    return [];
  }

  const nossosTotais = somarPorTributo(input.ours);
  const saida: Divergence[] = [];
  const tributos = new Set([...Object.keys(input.fiscoTotals), ...nossosTotais.keys()]);

  for (const tributo of tributos) {
    const nosso = nossosTotais.get(tributo) ?? 0;
    const deles = input.fiscoTotals[tributo] ?? 0;
    const diferenca = deles - nosso;

    if (diferenca === 0) {
      continue;
    }

    // Com detalhe, o total é a soma das linhas: reportá-lo de novo duplicaria o
    // valor na tela. Só sobra achado quando as linhas não explicam o total.
    //
    // O arredondamento somado entra na explicação, e isso não é detalhe: sem
    // ele, um único centavo de diferença de emissão sairia como divergência
    // CRÍTICA de "total que não fecha" — o alarme mais grave do módulo disparado
    // pelo achado mais banal.
    const explicadoPelasLinhas = deLinhas
      .filter((d) => d.tax === tributo)
      .reduce((soma, d) => soma + d.differenceCents, 0);

    const naoExplicado = diferenca - explicadoPelasLinhas;
    if (input.lineLevel && naoExplicado === 0) {
      continue;
    }

    saida.push({
      scope: 'tributo',
      subject: tributo,
      tax: tributo,
      direction: null,
      accessKey: null,
      line: null,
      ourCents: nosso,
      fiscoCents: deles,
      differenceCents: input.lineLevel ? naoExplicado : diferenca,
      probableCause: input.lineLevel ? 'total_nao_explicado_pelas_linhas' : 'causa_nao_determinada',
      severity: input.lineLevel ? 'critical' : 'high',
    });
  }

  return saida;
}

function somarPorTributo(linhas: readonly ComparableLine[]): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const linha of linhas) {
    mapa.set(linha.tax, (mapa.get(linha.tax) ?? 0) + linha.amountCents);
  }
  return mapa;
}

// ------------------------------------------------------------------ resumo

const ORDEM: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function ordenarPorGravidade(a: Divergence, b: Divergence): number {
  const porGravidade = ORDEM[a.severity] - ORDEM[b.severity];
  if (porGravidade !== 0) {
    return porGravidade;
  }
  return Math.abs(b.differenceCents) - Math.abs(a.differenceCents);
}

/** O corte vale só para item; documento e tributo cabem na tela sempre. */
function cortarItens(divergencias: readonly Divergence[]): Divergence[] {
  const itens = divergencias.filter((d) => d.scope === 'item');
  if (itens.length <= MAX_DIVERGENCIAS_DE_ITEM) {
    return [...divergencias];
  }

  const mantidos = new Set(itens.slice(0, MAX_DIVERGENCIAS_DE_ITEM));
  return divergencias.filter((d) => d.scope !== 'item' || mantidos.has(d));
}

function resumir(
  divergencias: readonly Divergence[],
  input: ComparisonInput,
): ComparisonSummary {
  const soma = (causa: ProbableCause): number =>
    divergencias
      .filter((d) => d.probableCause === causa)
      .reduce((total, d) => total + Math.abs(d.differenceCents), 0);

  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const divergencia of divergencias) {
    bySeverity[divergencia.severity] += 1;
  }

  return {
    divergencesCount: divergencias.length,
    exposureCents: soma('debito_nao_escriturado'),
    creditLossCents: soma('credito_nao_aproveitado'),
    creditAtRiskCents: soma('credito_glosado'),
    bySeverity,
    linesCompared: input.lineLevel ? contarComparadas(input) : 0,
    lineLevel: input.lineLevel,
  };
}

function contarComparadas(input: ComparisonInput): number {
  const doFisco = indexar(input.fisco);
  return input.ours.filter((linha) => doFisco.has(chave(linha))).length;
}
