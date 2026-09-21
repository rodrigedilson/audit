/**
 * Ancoragem das respostas do assistente.
 *
 * O contraexemplo que o briefing cita é um assistente genérico sem ancoragem nos
 * dados do CNPJ: ele compete com o ChatGPT e perde. O que muda aqui é que toda
 * afirmação factual carrega citação de um `event_seq` ou de uma chave de acesso
 * que existe no log **deste** CNPJ, e a citação é conferível pelo `POST /verify`.
 *
 * A garantia é mecânica, não uma instrução de prompt: `assertGrounded` recusa a
 * resposta antes de ela sair do serviço se uma afirmação factual não tiver
 * citação, **ou se citar algo que não está no conjunto de evidências que a
 * consulta de fato trouxe**. É o que torna a citação inventada impossível de
 * escapar, inclusive quando a resposta vier de um modelo de linguagem.
 */

export type CitationKind =
  | 'event'
  | 'document'
  | 'assessment_line'
  | 'divergence'
  | 'item'
  | 'period';

export interface Citation {
  kind: CitationKind;
  /** Posição no log, quando a evidência é um evento. Conferível pelo replay. */
  eventSeq?: number;
  accessKey?: string;
  line?: number;
  tax?: string;
  itemId?: string;
  period?: string;
  /** Rótulo curto para a tela; nunca substitui os campos acima. */
  label: string;
}

export type ClaimKind =
  /** Afirmação sobre os dados deste CNPJ. Exige citação. */
  | 'fact'
  /**
   * Texto normativo ou de procedimento, que não afirma nada sobre este CNPJ.
   *
   * Não cita dado porque não fala de dado — e por isso **não pode** conter
   * valor monetário nem competência: escrever um número aqui seria contrabandear
   * afirmação factual para fora da regra de citação.
   */
  | 'explanation';

export interface Claim {
  kind: ClaimKind;
  text: string;
  citations: Citation[];
}

/**
 * Ação recomendada. O assistente **não executa nada** — devolve o que o usuário
 * pode executar, com a rota e o corpo prontos.
 */
export interface SuggestedIntention {
  action: string;
  method: 'GET' | 'POST';
  endpoint: string;
  payload?: Record<string, unknown>;
  rationale: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Answer {
  intent: string;
  /** 1 = determinístico, sem modelo. 2 e 3 = modelo de linguagem (ADR-026). */
  tier: 1 | 2 | 3;
  confidence: Confidence;
  answerable: boolean;
  claims: Claim[];
  suggested: SuggestedIntention[];
  /** Obrigatório quando `answerable` é `false`. */
  unanswerableReason?: string;
}

/**
 * Conjunto de evidências que a consulta trouxe.
 *
 * Montado durante a recuperação, antes de qualquer texto ser escrito. Uma
 * citação que não esteja aqui é citação inventada, e a resposta é recusada.
 */
export class Evidence {
  private readonly chaves = new Set<string>();

  add(citation: Citation): Citation {
    this.chaves.add(chaveDaCitacao(citation));
    return citation;
  }

  has(citation: Citation): boolean {
    return this.chaves.has(chaveDaCitacao(citation));
  }

  get size(): number {
    return this.chaves.size;
  }
}

export class UngroundedAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UngroundedAnswerError';
  }
}

/** Valor monetário e competência: os dois vazamentos de fato que importam. */
const MOEDA = /R\$\s?-?[\d.,]+/;
const COMPETENCIA = /\b\d{4}-(0[1-9]|1[0-2])\b/;

export function assertGrounded(answer: Answer, evidence: Evidence): void {
  if (!answer.answerable) {
    if (!answer.unanswerableReason || answer.unanswerableReason.trim().length === 0) {
      throw new UngroundedAnswerError(
        'Resposta não respondível sem motivo declarado. "Não sei" sem o porquê é ' +
          'indistinguível de falha silenciosa.',
      );
    }
    // Uma resposta não respondível pode trazer as evidências que encontrou, e
    // elas seguem sujeitas à mesma checagem abaixo.
  }

  for (const claim of answer.claims) {
    verificarAfirmacao(claim, evidence);
  }

  if (answer.answerable && answer.claims.every((c) => c.kind === 'explanation')) {
    throw new UngroundedAnswerError(
      'Resposta respondível sem nenhuma afirmação factual: só explicação não ' +
        'responde uma pergunta sobre os dados do cliente.',
    );
  }
}

function verificarAfirmacao(claim: Claim, evidence: Evidence): void {
  if (claim.kind === 'fact') {
    if (claim.citations.length === 0) {
      throw new UngroundedAnswerError(
        `Afirmação factual sem citação: "${recortar(claim.text)}".`,
      );
    }

    for (const citation of claim.citations) {
      if (!evidence.has(citation)) {
        throw new UngroundedAnswerError(
          `Citação fora das evidências recuperadas: ${chaveDaCitacao(citation)} ` +
            `em "${recortar(claim.text)}". Citação que não veio da consulta é ` +
            'citação inventada.',
        );
      }
    }

    return;
  }

  if (MOEDA.test(claim.text)) {
    throw new UngroundedAnswerError(
      `Explicação com valor monetário: "${recortar(claim.text)}". Valor é ` +
        'afirmação factual e precisa de citação.',
    );
  }

  if (COMPETENCIA.test(claim.text)) {
    throw new UngroundedAnswerError(
      `Explicação referenciando competência: "${recortar(claim.text)}". ` +
        'Afirmação sobre um mês do cliente precisa de citação.',
    );
  }
}

function chaveDaCitacao(citation: Citation): string {
  switch (citation.kind) {
    case 'event':
      return `event:${citation.eventSeq}`;
    case 'document':
      return `document:${citation.accessKey}`;
    case 'assessment_line':
      return `line:${citation.accessKey}#${citation.line}#${citation.tax}`;
    case 'divergence':
      return `divergence:${citation.period}:${citation.label}`;
    case 'item':
      return `item:${citation.itemId}`;
    case 'period':
      return `period:${citation.period}`;
  }
}

function recortar(texto: string): string {
  return texto.length <= 80 ? texto : `${texto.slice(0, 77)}...`;
}

// ------------------------------------------------------------- construtores

export function fact(text: string, citations: Citation[]): Claim {
  return { kind: 'fact', text, citations };
}

export function explanation(text: string): Claim {
  return { kind: 'explanation', text, citations: [] };
}

export function eventCitation(eventSeq: number, label: string): Citation {
  return { kind: 'event', eventSeq, label };
}

export function documentCitation(accessKey: string): Citation {
  return { kind: 'document', accessKey, label: `NF-e …${accessKey.slice(-8)}` };
}

export function lineCitation(accessKey: string, line: number, tax: string): Citation {
  return {
    kind: 'assessment_line',
    accessKey,
    line,
    tax,
    label: `…${accessKey.slice(-8)} item ${line} ${tax.toUpperCase()}`,
  };
}

export function divergenceCitation(period: string, subject: string): Citation {
  return { kind: 'divergence', period, label: subject };
}

export function itemCitation(itemId: string): Citation {
  return { kind: 'item', itemId, label: itemId };
}

export function periodCitation(period: string): Citation {
  return { kind: 'period', period, label: `competência ${period}` };
}
