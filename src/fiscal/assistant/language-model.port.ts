import type { Intent } from './intent-classifier.js';

/**
 * Roteamento de camadas do ADR-026, aplicado ao assistente.
 *
 * | Camada | Quem atende | Latência | Custo |
 * |--------|-------------|----------|-------|
 * | 1 | consulta determinística ao banco | <1ms | zero |
 * | 2 | modelo pequeno, em lote | ~500ms | baixo |
 * | 3 | modelo grande, raciocínio livre | 2–5s | alto |
 *
 * O assistente usa **1 e 3**. A camada 2 do ADR existe para classificação de
 * item em lote, que é trabalho do módulo de catálogo e não de conversa —
 * declarar aqui um uso dela que não existe faria a tabela mentir.
 *
 * As intenções conhecidas são todas de camada 1: a resposta sai de consulta, é
 * reproduzível e cada número dela tem citação conferível pelo replay. É o que
 * separa este assistente do genérico que o briefing manda evitar.
 */
export function routeTier(intent: Intent): 1 | 3 {
  // Só o desconhecido precisaria de raciocínio livre — e é justamente onde o
  // produto não tem lastro para responder.
  return intent === 'desconhecido' ? 3 : 1;
}

/** Uma evidência já ancorada: fato que uma consulta determinística produziu. */
export interface ModelEvidence {
  /** `E1`, `E2`…: o único jeito de o modelo citar algo. */
  id: string;
  text: string;
}

export interface ModelRequest {
  question: string;
  /**
   * O que o modelo pode usar. Nada além disto: o modelo não vê o banco, só os
   * fatos que as consultas de camada 1 já trouxeram com citação.
   */
  evidence: ModelEvidence[];
}

export interface ModelClaim {
  kind: 'fact' | 'explanation';
  text: string;
  /** Evidências (`E1`…) que sustentam a afirmação. Obrigatório em `fact`. */
  evidenceIds: string[];
}

export interface ModelAnswer {
  answerable: boolean;
  /** Por que não dá para responder com as evidências dadas. */
  reason: string | null;
  claims: ModelClaim[];
}

/**
 * Porta para um modelo de linguagem.
 *
 * Sem provedor configurado, a pergunta de camada 3 recebe "não sei responder, e
 * eis o que sei" em vez de uma resposta plausível sem lastro.
 *
 * Com provedor, a resposta dele passa pelo **mesmo** `assertGrounded` das
 * respostas determinísticas: o modelo só cita evidência por id, a citação vira
 * a citação real da evidência, e id desconhecido é recusado antes de sair do
 * serviço. A garantia é mecânica, não uma instrução de prompt.
 */
export interface LanguageModelPort {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelAnswer>;
}
