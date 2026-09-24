import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import {
  Evidence,
  explanation,
  fact,
  type Answer,
  type Citation,
  type Claim,
} from './grounding.js';
import type { LanguageModelPort, ModelAnswer, ModelEvidence } from './language-model.port.js';
import {
  documentos,
  estadoDaCompetencia,
  porQueNaoDeterminavel,
  valorDevido,
} from './answers/assessment.js';
import { divergencias, prazos, saudeDoCadastro } from './answers/audit.js';

/**
 * Camada 3: pergunta que o classificador não reconheceu, respondida por modelo
 * de linguagem **sobre as evidências da camada 1**.
 *
 * O modelo nunca vê o banco. As consultas determinísticas rodam primeiro, cada
 * fato que elas produzem vira uma evidência numerada com as citações que a
 * consulta trouxe, e o modelo só pode recombinar essas evidências, citando-as
 * por id. Depois:
 *
 * - id que não existe é recusado;
 * - a citação de cada afirmação passa a ser a citação **real** da evidência, e
 *   `assertGrounded` confere, como em toda resposta;
 * - todo valor em R$ e toda competência que o modelo escrever têm de aparecer
 *   **literalmente** numa evidência citada. Sem isso, o modelo poderia citar a
 *   evidência certa com o número errado, e a citação válida carimbaria um valor
 *   inventado.
 */

/** Uma evidência para o modelo, com as citações que a sustentam. */
export interface EvidenciaNumerada extends ModelEvidence {
  citations: Citation[];
}

const MOEDA = /R\$\s?-?[\d.,]*\d/g;
const COMPETENCIA = /\b\d{4}-(?:0[1-9]|1[0-2])\b/g;

/**
 * Roda as consultas de camada 1 e numera os fatos que elas trouxeram. As
 * citações entram em `evidencia`, que é o conjunto contra o qual a resposta
 * final é conferida.
 */
export async function reunirEvidencias(
  pool: Pool,
  scope: EventScope,
  period: string | undefined,
  evidencia: Evidence,
): Promise<EvidenciaNumerada[]> {
  const consultas: Promise<Answer>[] = [
    saudeDoCadastro(pool, scope, 3, evidencia),
    prazos(pool, scope, 3, evidencia),
  ];
  if (period !== undefined) {
    consultas.push(
      estadoDaCompetencia(pool, scope, period, 3, evidencia),
      valorDevido(pool, scope, period, undefined, 3, evidencia),
      porQueNaoDeterminavel(pool, scope, period, 3, evidencia),
      divergencias(pool, scope, period, 3, evidencia),
      documentos(pool, scope, period, 3, evidencia),
    );
  }

  const respostas = await Promise.all(consultas);
  const fatos = respostas.flatMap((r) => r.claims).filter((c) => c.kind === 'fact');

  return fatos.map((c, i) => ({
    id: `E${i + 1}`,
    text: c.text,
    citations: c.citations,
  }));
}

/**
 * Converte a resposta do modelo numa `Answer`, ou devolve o motivo por que ela
 * não pode sair. Não lança: resposta sem lastro vira "não sei", nunca erro 500.
 */
export function montarResposta(
  modelo: ModelAnswer,
  evidencias: readonly EvidenciaNumerada[],
): { answer: Answer } | { rejeitada: string } {
  const porId = new Map(evidencias.map((e) => [e.id, e]));
  const claims: Claim[] = [];

  for (const c of modelo.claims) {
    if (c.kind === 'explanation') {
      claims.push(explanation(c.text));
      continue;
    }

    const citadas = c.evidenceIds.map((id) => porId.get(id));
    if (citadas.length === 0 || citadas.some((e) => e === undefined)) {
      return { rejeitada: `o modelo citou evidência inexistente ou nenhuma em "${recortar(c.text)}"` };
    }

    const textoCitado = citadas.map((e) => e!.text).join(' ');
    const inventado = [...(c.text.match(MOEDA) ?? []), ...(c.text.match(COMPETENCIA) ?? [])].find(
      (valor) => !textoCitado.includes(valor),
    );
    if (inventado !== undefined) {
      return {
        rejeitada: `o modelo escreveu "${inventado}", que não está nas evidências que citou`,
      };
    }

    claims.push(fact(c.text, citadas.flatMap((e) => e!.citations)));
  }

  if (!modelo.answerable) {
    return {
      answer: {
        intent: 'desconhecido',
        tier: 3,
        confidence: 'medium',
        answerable: false,
        claims,
        suggested: [],
        unanswerableReason:
          modelo.reason ?? 'O modelo não encontrou nas evidências deste CNPJ como responder.',
      },
    };
  }

  return {
    answer: {
      intent: 'desconhecido',
      tier: 3,
      // Média, e não alta: cada fato tem lastro, mas a composição e a
      // interpretação da pergunta são do modelo.
      confidence: 'medium',
      answerable: true,
      claims,
      suggested: [],
    },
  };
}

/** Pergunta de camada 3, do começo ao fim. */
export async function responderComModelo(
  modelo: LanguageModelPort,
  pool: Pool,
  scope: EventScope,
  question: string,
  period: string | undefined,
  evidencia: Evidence,
): Promise<{ answer: Answer } | { rejeitada: string }> {
  const evidencias = await reunirEvidencias(pool, scope, period, evidencia);
  const resposta = await modelo.complete({
    question,
    evidence: evidencias.map(({ id, text }) => ({ id, text })),
  });
  return montarResposta(resposta, evidencias);
}

function recortar(texto: string): string {
  return texto.length <= 60 ? texto : `${texto.slice(0, 57)}...`;
}
