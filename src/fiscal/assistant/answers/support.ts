import type { Answer, SuggestedIntention } from '../grounding.js';

/** Apoio comum aos construtores de resposta. */

export interface TaxTotalsRow {
  debitsCents: number | string;
  potentialCreditsCents: number | string;
  creditableCents: number | string | null;
  dueCents: number | string | null;
}

export const FALTA_PARA_AVANCAR: Record<
  string,
  { texto: string; sugestao: (cnpj: string, period: string) => SuggestedIntention[] }
> = {
  open: {
    texto:
      'Uma competência aberta ainda não tem débito nem crédito calculados. O passo ' +
      'seguinte é apurar, o que produz os valores a partir dos documentos ingeridos.',
    sugestao: (cnpj, period) => [
      {
        action: 'assessment.projected',
        method: 'POST',
        endpoint: `/v1/clients/${cnpj}/assessments/${period}`,
        rationale: 'Apurar é o passo seguinte de uma competência aberta.',
      },
    ],
  },
  assessed: {
    texto:
      'Apurada e não conciliada. A conciliação compara a nossa apuração com a proposta ' +
      'do Fisco, e é ela que habilita a confirmação.',
    sugestao: (cnpj, period) => [
      {
        action: 'assessment.compared',
        method: 'POST',
        endpoint: `/v1/clients/${cnpj}/fisco-assessments/${period}`,
        rationale: 'Enviar a proposta do Fisco produz a comparação e move para conciliada.',
      },
    ],
  },
  reconciled: {
    texto:
      'Conciliada e pronta para confirmar. A confirmação exige de volta o hash que a ' +
      'tela mostrou, e é o que fecha o mês com trilha de defesa.',
    sugestao: (cnpj, period) => [
      {
        action: 'assessment.confirmed',
        method: 'POST',
        endpoint: `/v1/clients/${cnpj}/assessments/${period}/confirm`,
        payload: { projection_hash: '<o hash exibido na apuração>' },
        rationale: 'Confirmar fecha a competência e gera o hash de fechamento.',
      },
    ],
  },
  confirmed: {
    texto:
      'Confirmada e fechada. A partir daqui a correção é por retificação, que abre ' +
      'competência vinculada e preserva o hash original — o mês fechado não é ' +
      'reescrito.',
    sugestao: (cnpj, period) => [
      {
        action: 'consulta',
        method: 'POST',
        endpoint: `/v1/clients/${cnpj}/books/${period}`,
        rationale: 'Com a competência fechada, o Book de fechamento pode ser gerado.',
      },
    ],
  },
};

export function naoRespondivel(
  intent: string,
  tier: 1 | 3,
  reason: string,
  suggested: SuggestedIntention[] = [],
): Answer {
  return {
    intent,
    tier,
    confidence: 'high',
    answerable: false,
    claims: [],
    suggested,
    unanswerableReason: reason,
  };
}

/** O texto que vai para `content`: a resposta lida de cima a baixo. */
export function resumoDaResposta(answer: Answer): string {
  if (!answer.answerable) {
    return answer.unanswerableReason ?? 'Não sei responder.';
  }
  return answer.claims.map((c) => c.text).join('\n\n');
}

export function rotuloDeEstado(estado: string): string {
  const mapa: Record<string, string> = {
    open: 'aberta',
    assessed: 'apurada',
    reconciled: 'conciliada',
    confirmed: 'confirmada e fechada',
  };
  return mapa[estado] ?? estado;
}

export function brl(centavos: number | string): string {
  return (Number(centavos) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
