import { parseNfe, DocumentParseError, type ParsedDocument, type ParseFailureReason } from './nfe-parser.js';
import type { UploadedFile } from './ingestion.service.js';

/**
 * Diagnóstico de prontidão da carteira para a reforma.
 *
 * Responde a uma pergunta que o escritório ainda não sabe que tem: **quantos dos
 * seus fornecedores já emitem com o grupo UB da NT 2025.002 (IBS/CBS)?** O
 * parser já calcula `hasReformGroup` por documento desde a ingestão; aqui isso
 * vira um retrato agregado da carteira.
 *
 * ---------------------------------------------------------------------------
 * Por que é função pura, e não lógica dentro do handler
 * ---------------------------------------------------------------------------
 * Três razões, nesta ordem:
 *
 * 1. **Cobertura.** Todo teste de API se pula sozinho sem banco
 *    (`describe.skipIf(!DATABASE_URL)`). Lógica dentro de handler não é medida
 *    em máquina sem Postgres, e o piso de cobertura do projeto é alto.
 * 2. **Domínio.** Agregar prontidão é assunto fiscal, não HTTP. A mesma função
 *    serve o relatório autenticado da carteira, que lê `documents.has_reform_group`.
 * 3. **Prova.** A rota pública promete não guardar documento de ninguém. Uma
 *    função que não recebe `Pool` torna isso verificável por construção, em vez
 *    de depender de revisão de código.
 */

export interface ReadinessTotals {
  documents: number;
  parsed: number;
  rejected: number;
  /** XMLs repetidos no mesmo lote; não entram no denominador. */
  duplicates: number;
}

export interface ReadinessRatio {
  total: number;
  ready: number;
  /**
   * Percentual com uma casa. Derivado, mas devolvido pronto: se a tela refizer
   * a conta, ela diverge do número que o próprio relatório afirma.
   */
  readyPct: number;
}

export interface IssuerReadiness {
  cnpj: string;
  name: string;
  documents: ReadinessRatio;
  totalCents: number;
}

export interface NcmReadiness {
  ncm: string;
  items: ReadinessRatio;
}

export interface PeriodReadiness {
  period: string;
  documents: ReadinessRatio;
}

export interface ReadinessRejection {
  filename: string;
  layer: 1 | 2;
  reason: ParseFailureReason;
  message: string;
}

export interface ReadinessReport {
  totals: ReadinessTotals;
  /**
   * Prontidão em três recortes, porque contam histórias diferentes: 10% dos
   * documentos podem ser 80% do valor, e é esse achado que mostra o tamanho do
   * problema.
   */
  documentsReady: ReadinessRatio;
  itemsReady: ReadinessRatio;
  valueReady: { totalCents: number; readyCents: number; readyPct: number };
  periods: readonly PeriodReadiness[];
  issuers: readonly IssuerReadiness[];
  issuersTruncated: boolean;
  ncms: readonly NcmReadiness[];
  ncmsTruncated: boolean;
  rejections: readonly ReadinessRejection[];
}

export interface ReadinessOptions {
  /** Teto de linhas por agrupamento. */
  topN?: number;
}

const TOP_N_PADRAO = 50;

/** Item sem NCM é achado, não vazio: agrupa sob um rótulo em vez de sumir. */
const SEM_NCM = '(sem NCM)';

/**
 * Agrega um lote de XMLs. Pura: sem I/O, sem banco, sem escritório.
 *
 * Um arquivo ruim nunca derruba o lote — é a mesma regra do 207 da ingestão,
 * pela mesma razão: quem sobe a pasta do mês não pode perder as outras notas
 * por causa de uma.
 */
export function summarizeReadiness(
  files: readonly UploadedFile[],
  options: ReadinessOptions = {},
): ReadinessReport {
  const topN = options.topN ?? TOP_N_PADRAO;

  const parsed: ParsedDocument[] = [];
  const rejections: ReadinessRejection[] = [];
  const vistos = new Set<string>();
  let duplicates = 0;

  for (const file of files) {
    try {
      const documento = parseNfe(file.content);

      // A mesma pasta subida duas vezes não pode dobrar o denominador e fazer o
      // percentual parecer melhor (ou pior) do que é.
      if (vistos.has(documento.accessKey)) {
        duplicates += 1;
        continue;
      }
      vistos.add(documento.accessKey);
      parsed.push(documento);
    } catch (erro) {
      rejections.push(paraRejeicao(file.filename, erro));
    }
  }

  return {
    totals: {
      documents: files.length,
      parsed: parsed.length,
      rejected: rejections.length,
      duplicates,
    },
    documentsReady: razao(parsed.length, parsed.filter((d) => d.hasReformGroup).length),
    itemsReady: prontidaoDeItens(parsed),
    valueReady: prontidaoDeValor(parsed),
    periods: porCompetencia(parsed),
    ...porEmitente(parsed, topN),
    ...porNcm(parsed, topN),
    rejections,
  };
}

function razao(total: number, ready: number): ReadinessRatio {
  return {
    total,
    ready,
    // Sem documento não há percentual: zero em vez de NaN, que quebraria a tela.
    readyPct: total === 0 ? 0 : Math.round((ready / total) * 1000) / 10,
  };
}

function prontidaoDeItens(docs: readonly ParsedDocument[]): ReadinessRatio {
  let total = 0;
  let ready = 0;
  for (const doc of docs) {
    for (const item of doc.items) {
      total += 1;
      if (item.reform !== undefined) {
        ready += 1;
      }
    }
  }
  return razao(total, ready);
}

/**
 * Prontidão ponderada por valor. É o recorte que costuma surpreender: a carteira
 * pode estar 25% pronta em documentos e 80% em dinheiro, ou o contrário.
 */
function prontidaoDeValor(docs: readonly ParsedDocument[]): ReadinessReport['valueReady'] {
  let totalCents = 0;
  let readyCents = 0;
  for (const doc of docs) {
    totalCents += doc.totalCents;
    if (doc.hasReformGroup) {
      readyCents += doc.totalCents;
    }
  }
  return {
    totalCents,
    readyCents,
    readyPct: totalCents === 0 ? 0 : Math.round((readyCents / totalCents) * 1000) / 10,
  };
}

function porCompetencia(docs: readonly ParsedDocument[]): PeriodReadiness[] {
  const mapa = new Map<string, { total: number; ready: number }>();
  for (const doc of docs) {
    const atual = mapa.get(doc.period) ?? { total: 0, ready: 0 };
    atual.total += 1;
    if (doc.hasReformGroup) {
      atual.ready += 1;
    }
    mapa.set(doc.period, atual);
  }

  return [...mapa.entries()]
    // Cronológica: a tela mostra a evolução da adesão dos fornecedores.
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, contagem]) => ({ period, documents: razao(contagem.total, contagem.ready) }));
}

function porEmitente(
  docs: readonly ParsedDocument[],
  topN: number,
): Pick<ReadinessReport, 'issuers' | 'issuersTruncated'> {
  const mapa = new Map<
    string,
    { total: number; ready: number; totalCents: number; nomes: Map<string, number> }
  >();

  for (const doc of docs) {
    const atual = mapa.get(doc.issuerCnpj) ?? {
      total: 0,
      ready: 0,
      totalCents: 0,
      nomes: new Map<string, number>(),
    };
    atual.total += 1;
    atual.totalCents += doc.totalCents;
    if (doc.hasReformGroup) {
      atual.ready += 1;
    }
    if (doc.issuerName) {
      atual.nomes.set(doc.issuerName, (atual.nomes.get(doc.issuerName) ?? 0) + 1);
    }
    mapa.set(doc.issuerCnpj, atual);
  }

  const todos: IssuerReadiness[] = [...mapa.entries()]
    .map(([cnpj, dados]) => ({
      cnpj,
      // Razão social varia de grafia entre notas do mesmo CNPJ; a mais
      // frequente é a menos sujeita a um erro de digitação isolado.
      name: maisFrequente(dados.nomes),
      documents: razao(dados.total, dados.ready),
      totalCents: dados.totalCents,
    }))
    .sort((a, b) => b.documents.total - a.documents.total || a.cnpj.localeCompare(b.cnpj));

  // Truncar depois de agregar: 200 XMLs podem ter 200 emitentes, e uma resposta
  // ilimitada vira despejo de dados em vez de diagnóstico. Os números globais
  // são calculados sobre tudo, então o corte não os distorce.
  return { issuers: todos.slice(0, topN), issuersTruncated: todos.length > topN };
}

function porNcm(
  docs: readonly ParsedDocument[],
  topN: number,
): Pick<ReadinessReport, 'ncms' | 'ncmsTruncated'> {
  const mapa = new Map<string, { total: number; ready: number }>();

  for (const doc of docs) {
    for (const item of doc.items) {
      const chave = item.ncm?.trim() ? item.ncm.trim() : SEM_NCM;
      const atual = mapa.get(chave) ?? { total: 0, ready: 0 };
      atual.total += 1;
      if (item.reform !== undefined) {
        atual.ready += 1;
      }
      mapa.set(chave, atual);
    }
  }

  const todos: NcmReadiness[] = [...mapa.entries()]
    .map(([ncm, contagem]) => ({ ncm, items: razao(contagem.total, contagem.ready) }))
    .sort((a, b) => b.items.total - a.items.total || a.ncm.localeCompare(b.ncm));

  return { ncms: todos.slice(0, topN), ncmsTruncated: todos.length > topN };
}

function maisFrequente(nomes: Map<string, number>): string {
  let escolhido = '';
  let maior = 0;
  for (const [nome, vezes] of nomes) {
    if (vezes > maior || (vezes === maior && nome.localeCompare(escolhido) < 0)) {
      escolhido = nome;
      maior = vezes;
    }
  }
  return escolhido;
}

/**
 * Converte a falha em linha do relatório. Erro inesperado do parser vira
 * `schema_violation` de camada 1 com mensagem neutra: um `TypeError` vazando
 * numa rota pública não pode virar 500 nem expor pilha de execução.
 */
function paraRejeicao(filename: string, erro: unknown): ReadinessRejection {
  if (erro instanceof DocumentParseError) {
    return { filename, layer: erro.layer, reason: erro.reason, message: erro.message };
  }
  return {
    filename,
    layer: 1,
    reason: 'schema_violation',
    message: 'Arquivo não é um XML de NF-e ou NFC-e legível.',
  };
}
