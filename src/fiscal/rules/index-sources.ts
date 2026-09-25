/**
 * Fontes oficiais das séries de índice, e a leitura de cada uma.
 *
 * Tudo aqui é puro: recebe o JSON que a fonte devolveu e devolve pontos. A rede
 * fica em `index-loader.ts`, para dar para testar a leitura com a resposta real
 * gravada, sem depender de o IBGE ou o BCB estarem no ar.
 *
 * Códigos conferidos nas próprias APIs em 25/09/2026:
 *
 * | Índice | Fonte primária            | Conferência cruzada |
 * |--------|---------------------------|---------------------|
 * | IPCA   | IBGE SIDRA, t1737, v63    | BCB SGS 433         |
 * | INPC   | IBGE SIDRA, t1736, v44    | BCB SGS 188         |
 * | IGP-M  | BCB SGS 189 (republica a FGV) | —              |
 * | TR     | BCB SGS 7811 (mensal; a 226 é diária) | —      |
 * | SELIC  | BCB SGS 4390 (acumulada no mês) | —            |
 */

export interface OfficialPoint {
  /** `YYYY-MM`. */
  period: string;
  /** Fração, e não percentual: 0,42% é `0.0042` (regra da migration 34). */
  variation: number;
}

export type SourceKind = 'sidra' | 'sgs';

export interface SourceRef {
  kind: SourceKind;
  /** SIDRA: `t1737/v63`. SGS: o código da série. */
  code: string;
}

export interface IndexSourceSpec {
  indexId: string;
  primary: SourceRef;
  /** Segunda fonte oficial para conferir mês a mês, quando existe. */
  crossCheck: SourceRef | null;
}

export const INDEX_SOURCES: readonly IndexSourceSpec[] = [
  { indexId: 'ipca', primary: { kind: 'sidra', code: 't1737/v63' }, crossCheck: { kind: 'sgs', code: '433' } },
  { indexId: 'inpc', primary: { kind: 'sidra', code: 't1736/v44' }, crossCheck: { kind: 'sgs', code: '188' } },
  { indexId: 'igpm', primary: { kind: 'sgs', code: '189' }, crossCheck: null },
  { indexId: 'tr', primary: { kind: 'sgs', code: '7811' }, crossCheck: null },
  { indexId: 'selic', primary: { kind: 'sgs', code: '4390' }, crossCheck: null },
];

export class IndexSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexSourceError';
  }
}

/** Marcadores do SIDRA para "não há dado": não disponível, não se aplica, sigilo. */
const SIDRA_SEM_DADO = new Set(['...', '..', '-', 'X']);

/**
 * Percentual da fonte (`"0.16"`, `"-0.32"`) em fração. A divisão é feita sobre a
 * representação decimal, e não com `Number(x) / 100`, para `0.07` virar
 * `0.0007` e não `0.0007000000000000001`.
 */
function fracao(valor: string, onde: string): number {
  const limpo = valor.trim();
  if (!/^-?\d+(\.\d+)?$/.test(limpo)) {
    throw new IndexSourceError(`Valor não numérico em ${onde}: ${JSON.stringify(valor)}.`);
  }
  const casas = (limpo.split('.')[1] ?? '').length;
  return Number((Number(limpo) / 100).toFixed(casas + 2));
}

/**
 * A competência corrente ainda não fechou: a SELIC do mês (4390), por exemplo,
 * já aparece acumulada até ontem. Guardá-la faria um laudo corrigir com um mês
 * pela metade. Competência futura, por definição, também não entra.
 */
function competenciaFechada(period: string, now: Date): boolean {
  // Horário de Brasília (UTC−3, sem horário de verão desde 2019).
  const local = new Date(now.getTime() - 3 * 3600_000);
  const corrente = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  return period < corrente;
}

function ordenar(pontos: OfficialPoint[], now: Date): OfficialPoint[] {
  const porCompetencia = new Map<string, OfficialPoint>();
  for (const p of pontos) {
    if (!competenciaFechada(p.period, now)) continue;
    if (porCompetencia.has(p.period)) {
      throw new IndexSourceError(`A fonte trouxe duas vezes a competência ${p.period}.`);
    }
    porCompetencia.set(p.period, p);
  }
  return [...porCompetencia.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * BCB SGS: `[{"data":"01/06/2026","valor":"0.16"}, …]`, sem ordem garantida.
 * Série mensal vem datada no dia 1; o que importa é o mês.
 */
export function lerSgs(json: unknown, now: Date): OfficialPoint[] {
  if (!Array.isArray(json)) {
    throw new IndexSourceError('A resposta do SGS não é uma lista.');
  }
  const pontos = json.map((item: unknown, i) => {
    const registro = item as { data?: unknown; valor?: unknown };
    const data = typeof registro.data === 'string' ? registro.data : '';
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data);
    if (m === null || typeof registro.valor !== 'string') {
      throw new IndexSourceError(`Registro ${i} do SGS fora do formato: ${JSON.stringify(item)}.`);
    }
    return { period: `${m[3]}-${m[2]}`, variation: fracao(registro.valor, `SGS ${data}`) };
  });
  return ordenar(pontos, now);
}

/**
 * IBGE SIDRA: a primeira linha é o cabeçalho, e cada linha seguinte traz o mês
 * em `D3C` (`aaaamm`) e o valor em `V`. Período sem dado vem como `...`, e
 * resposta só com o cabeçalho é série vazia — não erro.
 */
export function lerSidra(json: unknown, now: Date): OfficialPoint[] {
  if (!Array.isArray(json) || json.length === 0) {
    throw new IndexSourceError('A resposta do SIDRA não é uma lista com cabeçalho.');
  }
  const pontos: OfficialPoint[] = [];
  json.slice(1).forEach((item: unknown, i) => {
    const registro = item as { D3C?: unknown; V?: unknown };
    const mes = typeof registro.D3C === 'string' ? registro.D3C : '';
    if (!/^\d{6}$/.test(mes) || typeof registro.V !== 'string') {
      throw new IndexSourceError(`Linha ${i + 1} do SIDRA fora do formato: ${JSON.stringify(item)}.`);
    }
    if (SIDRA_SEM_DADO.has(registro.V.trim())) return;
    pontos.push({
      period: `${mes.slice(0, 4)}-${mes.slice(4)}`,
      variation: fracao(registro.V, `SIDRA ${mes}`),
    });
  });
  return ordenar(pontos, now);
}

export interface CrossCheckResult {
  /** Meses presentes nas duas fontes. */
  compared: number;
  /** Meses em que as duas fontes discordam, com os dois valores. */
  divergences: { period: string; primary: number; crossCheck: number }[];
}

/**
 * Confere a fonte primária contra a segunda, mês a mês, nos meses em comum.
 * As duas publicam o percentual com duas casas; a comparação é exata nessa
 * precisão, porque "quase igual" num índice é índice diferente.
 */
export function conferirFontes(
  primary: readonly OfficialPoint[],
  crossCheck: readonly OfficialPoint[],
): CrossCheckResult {
  const segunda = new Map(crossCheck.map((p) => [p.period, p.variation]));
  const divergences: CrossCheckResult['divergences'] = [];
  let compared = 0;
  for (const p of primary) {
    const outra = segunda.get(p.period);
    if (outra === undefined) continue;
    compared += 1;
    if (Math.round(p.variation * 10_000) !== Math.round(outra * 10_000)) {
      divergences.push({ period: p.period, primary: p.variation, crossCheck: outra });
    }
  }
  return { compared, divergences };
}

/** URL de consulta de uma fonte, no intervalo `[desde, ate]` (competências). */
export function urlDaFonte(ref: SourceRef, desde: string, ate: string): string {
  if (ref.kind === 'sidra') {
    const [tabela, variavel] = ref.code.split('/') as [string, string];
    return (
      `https://apisidra.ibge.gov.br/values/${tabela.replace('t', 't/')}/n1/all/` +
      `${variavel.replace('v', 'v/')}/p/${desde.replace('-', '')}-${ate.replace('-', '')}?formato=json`
    );
  }
  const [ai, mi] = desde.split('-');
  const [af, mf] = ate.split('-') as [string, string];
  // Último dia do mês final: dia 0 do mês seguinte.
  const ultimo = new Date(Date.UTC(Number(af), Number(mf), 0)).getUTCDate();
  return (
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${ref.code}/dados?formato=json` +
    `&dataInicial=01/${mi}/${ai}&dataFinal=${ultimo}/${mf}/${af}`
  );
}

/** Rótulo curto da fonte, para `source_ref`. */
export function rotuloDaFonte(ref: SourceRef): string {
  return ref.kind === 'sidra' ? `IBGE SIDRA ${ref.code}` : `BCB SGS ${ref.code}`;
}
