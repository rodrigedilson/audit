import type { CapagExtraction } from './capag-extraction.js';

/**
 * Extrator da CAPAG de um documento. O Claude é a implementação; os testes
 * usam um dublê. Recebe o **texto** já extraído, e não o arquivo: o que o
 * modelo lê tem de ser exatamente o que a conferência compara.
 */
export interface CapagExtractorPort {
  readonly name: string;
  extract(input: { text: string; hint: 'demonstrativo' | 'referencia' }): Promise<CapagExtraction>;
}
