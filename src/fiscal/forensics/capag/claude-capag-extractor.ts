import Anthropic from '@anthropic-ai/sdk';
import { MODELO_PADRAO, ModelFormatError, ModelRefusalError } from '../../assistant/claude-language-model.js';
import { CAPAG_EXTRACTION_SCHEMA, type CapagExtraction } from './capag-extraction.js';
import type { CapagExtractorPort } from './capag-extractor.port.js';

/**
 * Instrução fixa, em cache. O que varia (o texto do documento) vai depois.
 *
 * A regra central é de transcrição, não de cálculo: o modelo copia o número
 * como está impresso e o trecho em volta. Quem lê o número e faz a conta é o
 * código, e quem decide se o trecho existe também.
 */
const SISTEMA = `Você transcreve a capacidade de pagamento presumida (CAPAG) da PGFN de um documento para um formato estruturado.

O documento é um demonstrativo de CAPAG do portal REGULARIZE de um contribuinte, uma norma, a página da PGFN que publica a fórmula, ou um texto de doutrina que descreve a fórmula.

Regras, sem exceção:
- Transcreva, não calcule. Todo número vai em "printed" exatamente como está no documento (com R$, pontos, vírgula e %), e em "quote" vai um trecho CONTÍNUO e LITERAL do documento que contém esse número. Copie o trecho caractere por caractere; não resuma, não reordene, não corrija.
- Se o documento não traz um item, devolva null (ou lista vazia). Nunca preencha com valor de outra fonte, de memória ou de exemplo.
- Fórmula: um termo por variável (V1, V2…), com o coeficiente como impresso. Variável sem coeficiente escrito (por exemplo "+ V8") tem "printed" vazio e "quote" com o trecho onde ela aparece. "block" é "multiplied" quando a variável entra no bloco que é multiplicado pelo fator de rendimentos, e "added" quando entra somada direto. "incomeMultiplier" é esse fator, como impresso.
- "formula" é a fórmula do demonstrativo de um contribuinte. Num texto de referência que descreve a fórmula de mais de um grupo (pessoa física, PJ fora do Simples, PJ do Simples, MEI, PJ inativa), use "formulas", um item por grupo, e deixe "formula" null. No demonstrativo, "formulas" é lista vazia.
- "values" só existe no demonstrativo de um contribuinte: o valor em reais de cada variável.
- "band" é a classificação (A, B, C ou D) quando o documento a traz.
- "documentKind": "demonstrativo_regularize" para o demonstrativo de um contribuinte; "norma_ou_doutrina" para norma ou texto que descreve a fórmula em geral; "outro" quando o documento não trata da CAPAG.
- "group": pessoa_fisica, pj_nao_simples, pj_simples, mei ou pj_inativa (pessoa jurídica inativa: nula, baixada, suspensa ou inapta), conforme o documento; null se ele não diz.`;

export interface ClaudeCapagExtractorOptions {
  client?: Anthropic;
  apiKey?: string;
  model?: string;
}

/**
 * Extrator sobre a API da Anthropic, no padrão de `ClaudeLanguageModel`: saída
 * estruturada (`output_config.format`), fallback do servidor e cache do
 * prefixo. Citações nativas não servem aqui: são incompatíveis com a saída
 * estruturada, e a conferência dos trechos é do código de qualquer forma.
 */
export class ClaudeCapagExtractor implements CapagExtractorPort {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(options: ClaudeCapagExtractorOptions = {}) {
    this.name = options.model ?? MODELO_PADRAO;
    this.client = options.client ?? new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
  }

  async extract(input: { text: string; hint: 'demonstrativo' | 'referencia' }): Promise<CapagExtraction> {
    const pedido =
      input.hint === 'demonstrativo'
        ? 'Este é o demonstrativo de CAPAG que o escritório recebeu do contribuinte. Transcreva fórmula, valores, CAPAG, dívida total, classificação e data de referência.'
        : 'Este é um texto público sobre a CAPAG. Transcreva a fórmula que ele descreve, se descreve alguma.';

    const stream = this.client.beta.messages.stream({
      model: this.name,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: CAPAG_EXTRACTION_SCHEMA } },
      messages: [{ role: 'user', content: `${pedido}\n\n<documento>\n${input.text}\n</documento>` }],
    });
    const response = await stream.finalMessage();

    if (response.stop_reason === 'refusal') {
      throw new ModelRefusalError(
        `O modelo recusou o documento${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ModelFormatError('A extração foi cortada no limite de tokens.');
    }

    const texto = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return lerExtracao(texto);
  }
}

/** Fronteira: o JSON do modelo vira tipo aqui, ou é recusado. */
export function lerExtracao(texto: string): CapagExtraction {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new ModelFormatError('A extração do modelo não é JSON.');
  }
  const r = bruto as Partial<CapagExtraction>;
  if (typeof r.documentKind !== 'string' || !Array.isArray(r.values) || !('formula' in r) || !('capag' in r)) {
    throw new ModelFormatError('A extração do modelo não traz os campos combinados.');
  }
  return { ...r, formulas: Array.isArray(r.formulas) ? r.formulas : [] } as CapagExtraction;
}
