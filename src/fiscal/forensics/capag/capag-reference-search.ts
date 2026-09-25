import Anthropic from '@anthropic-ai/sdk';
import { MODELO_PADRAO, ModelRefusalError } from '../../assistant/claude-language-model.js';
import { conferirExtracao, normalizar } from './capag-extraction.js';
import type { CapagExtractorPort } from './capag-extractor.port.js';
import { extractDocumentText } from './document-text.js';
import type { CapagTerm } from '../calc/capag.js';

/**
 * Buscador da fórmula de referência da CAPAG em fonte pública.
 *
 * Três etapas, e o modelo só faz a primeira sozinho:
 *
 * 1. **Busca.** O Claude, com `web_search`, levanta as páginas que descrevem a
 *    fórmula. Dele só se aproveitam as URLs que a própria busca devolveu.
 * 2. **Leitura.** O código baixa cada página: o texto que vai ser citado é o
 *    que o código leu, e não o que o modelo diz ter lido.
 * 3. **Extração e conferência.** O mesmo extrator do demonstrativo, e a mesma
 *    conferência trecho a trecho. Fonte cujo coeficiente não está, literal, na
 *    página baixada é descartada.
 *
 * O resultado é referência, e nunca conferido: a fórmula oficial só aparece no
 * REGULARIZE, com login do contribuinte (Portaria PGFN 6.757/2022, art. 28).
 */

export interface ReferenceSource {
  url: string;
  quotes: string[];
}

export interface ReferenceCandidate {
  group: string;
  incomeMultiplier: number;
  terms: readonly CapagTerm[];
  legalBasis: string | null;
  /** Páginas que trazem esta mesma fórmula, cada uma com os trechos conferidos. */
  sources: ReferenceSource[];
}

export interface SearchReport {
  urlsFound: string[];
  discarded: { url: string; reason: string }[];
  candidates: ReferenceCandidate[];
}

const PEDIDO_DE_BUSCA =
  'Procure páginas públicas (PGFN, normas, artigos de escritórios de advocacia ou contabilidade) que descrevam a ' +
  'fórmula da capacidade de pagamento presumida (CAPAG-P) da PGFN, com as variáveis (V1, V2…) e os coeficientes. ' +
  'Faça as buscas e, ao final, liste as URLs mais relevantes, uma por linha. Não reproduza a fórmula de memória.';

/** Etapa 1: as URLs que a busca do servidor devolveu, com `pause_turn` tratado. */
export async function buscarUrls(client: Anthropic, model = MODELO_PADRAO, maxResultados = 8): Promise<string[]> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: PEDIDO_DE_BUSCA }];
  const urls = new Set<string>();

  for (let continuacao = 0; continuacao < 5; continuacao += 1) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages,
    });
    if (response.stop_reason === 'refusal') {
      throw new ModelRefusalError('O modelo recusou a busca.');
    }
    for (const bloco of response.content) {
      // Erro da ferramenta vem como objeto no `content`, não como exceção.
      if (bloco.type === 'web_search_tool_result' && Array.isArray(bloco.content)) {
        for (const resultado of bloco.content) {
          if (resultado.type === 'web_search_result') urls.add(resultado.url);
        }
      }
    }
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  return [...urls].slice(0, maxResultados);
}

export type FetchBytes = (url: string) => Promise<{ bytes: Uint8Array; contentType: string | null }>;

export const fetchBytesPadrao: FetchBytes = async (url) => {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!resposta.ok) throw new Error(`respondeu ${resposta.status}`);
  return { bytes: new Uint8Array(await resposta.arrayBuffer()), contentType: resposta.headers.get('content-type') };
};

/** Etapas 2 e 3, sobre URLs já levantadas. Separadas para dar para testar sem rede nem modelo. */
export async function extrairReferencias(
  urls: readonly string[],
  extractor: CapagExtractorPort,
  fetchBytes: FetchBytes,
): Promise<SearchReport> {
  const discarded: SearchReport['discarded'] = [];
  const porFormula = new Map<string, ReferenceCandidate>();

  for (const url of urls) {
    let texto: string;
    try {
      const { bytes, contentType } = await fetchBytes(url);
      texto = (await extractDocumentText(bytes, contentType)).text;
    } catch (erro) {
      discarded.push({ url, reason: `não foi possível ler a página: ${erro instanceof Error ? erro.message : String(erro)}` });
      continue;
    }

    const extracao = await extractor.extract({ text: texto, hint: 'referencia' });
    if (extracao.formula === null || extracao.formula.terms.length === 0) {
      discarded.push({ url, reason: 'a página não traz a fórmula' });
      continue;
    }
    // Referência não tem valores nem CAPAG do contribuinte: só a fórmula conta.
    const conferencia = conferirExtracao(
      { ...extracao, documentKind: 'norma_ou_doutrina', values: [], capag: null, totalDebt: null, band: null, referenceDate: null },
      texto,
    );
    const problemasDaFormula = conferencia.problems.filter((p) => !p.startsWith('O documento não identifica o grupo'));
    if (problemasDaFormula.length > 0 || conferencia.formula === null) {
      discarded.push({ url, reason: `trecho não confere: ${problemasDaFormula[0] ?? 'fórmula incompleta'}` });
      continue;
    }

    const formula = conferencia.formula;
    const grupo = extracao.group ?? 'pj_nao_simples';
    const assinatura = JSON.stringify([
      grupo,
      formula.incomeMultiplier,
      formula.terms.map((t) => [t.variable, t.coefficient, t.block]),
    ]);
    const quotes = [
      ...(extracao.formula.incomeMultiplier ? [normalizar(extracao.formula.incomeMultiplier.quote)] : []),
      ...extracao.formula.terms.map((t) => normalizar(t.coefficient.quote)),
    ];
    const existente = porFormula.get(assinatura);
    if (existente) {
      existente.sources.push({ url, quotes });
    } else {
      porFormula.set(assinatura, {
        group: grupo,
        incomeMultiplier: formula.incomeMultiplier,
        terms: formula.terms,
        legalBasis: extracao.legalBasis,
        sources: [{ url, quotes }],
      });
    }
  }

  // A fórmula que mais fontes trazem vem primeiro.
  const candidates = [...porFormula.values()].sort((a, b) => b.sources.length - a.sources.length);
  return { urlsFound: [...urls], discarded, candidates };
}
