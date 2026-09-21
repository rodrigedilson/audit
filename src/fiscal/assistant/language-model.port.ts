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

export interface ModelRequest {
  question: string;
  /** Evidências recuperadas, em texto, para o modelo não precisar inventar. */
  context: string;
}

export interface ModelAnswer {
  text: string;
  /** `event_seq` que o modelo alega sustentarem a resposta. */
  citedEventSeqs: number[];
}

/**
 * Porta para um modelo de linguagem.
 *
 * Nenhuma implementação é registrada por padrão, e isso é uma escolha: sem
 * provedor configurado, a pergunta de camada 3 recebe "não sei responder, e eis
 * o que sei" em vez de uma resposta plausível sem lastro.
 *
 * Quando um provedor entrar, a resposta dele passa pelo **mesmo**
 * `assertGrounded` das respostas determinísticas: citação que não esteja nas
 * evidências recuperadas é recusada antes de sair do serviço. A garantia é
 * mecânica, não uma instrução de prompt.
 */
export interface LanguageModelPort {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelAnswer>;
}
