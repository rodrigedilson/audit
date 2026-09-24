/**
 * Classificação da pergunta em intenção, por correspondência determinística.
 *
 * **Não é compreensão de linguagem natural.** É casamento de termos sobre um
 * conjunto fechado de perguntas que este sistema sabe responder a partir dos
 * dados. A escolha é deliberada: uma intenção adivinhada faz o assistente
 * responder com confiança a uma pergunta que não foi feita, e no contexto fiscal
 * isso é pior do que não responder.
 *
 * Por isso `desconhecido` é o padrão, e não um palpite: a resposta passa a ser
 * "não entendi, e eis o que sei responder", que é verdadeira.
 */

import { isValidAccessKey } from '../ingestion/access-key.js';

export type Intent =
  | 'estado_da_competencia'
  | 'valor_devido'
  | 'por_que_nao_determinavel'
  | 'divergencias_do_fisco'
  | 'saude_do_cadastro'
  | 'documentos_do_periodo'
  | 'historico_do_documento'
  | 'prazos_e_pendencias'
  | 'desconhecido';

export interface Classification {
  intent: Intent;
  /** Competência mencionada, quando há. */
  period?: string;
  /** Chave de acesso de 44 dígitos mencionada, quando há. */
  accessKey?: string;
  tax?: string;
  /** Termos que decidiram a classificação, para a tela poder mostrar o porquê. */
  matched: string[];
}

interface Regra {
  intent: Exclude<Intent, 'desconhecido'>;
  /** Pelo menos um destes é obrigatório: é o sinal forte. */
  gatilhos: readonly string[];
  /** Somam confiança, mas não bastam sozinhos. */
  reforcos?: readonly string[];
}

/**
 * A ordem importa: a primeira regra com gatilho vence.
 *
 * `por_que_nao_determinavel` vem antes de `valor_devido` de propósito — "por que
 * o devido está nulo" contém "devido", e responder o valor a quem perguntou o
 * motivo seria responder outra pergunta.
 */
const REGRAS: readonly Regra[] = [
  {
    intent: 'por_que_nao_determinavel',
    gatilhos: [
      'nao determinavel',
      'não determinável',
      'por que nulo',
      'por que esta nulo',
      'por que está nulo',
      'por que nao calculou',
      'por que não calculou',
      'nao foi calculado',
      'não foi calculado',
      // `nulo` sozinho basta neste domínio: ninguém pergunta sobre "nulo"
      // exceto sobre o valor que não pôde ser determinado. `zerado` não entra —
      // zero é um valor de verdade, e responder o motivo a quem perguntou o
      // valor seria trocar a pergunta.
      'nulo',
    ],
  },
  {
    intent: 'divergencias_do_fisco',
    gatilhos: [
      'fisco',
      'divergencia',
      'divergência',
      'contra-apuracao',
      'contra-apuração',
      'apuracao assistida',
      'apuração assistida',
      'receita discorda',
    ],
    reforcos: ['proposta', 'discorda', 'diferenca', 'diferença'],
  },
  {
    intent: 'saude_do_cadastro',
    gatilhos: [
      'cadastro',
      'classificacao',
      'classificação',
      'ncm',
      'cclasstrib',
      'cfop',
      'mal classificad',
      'saude dos itens',
      'saúde dos itens',
    ],
    reforcos: ['errado', 'problema', 'saude', 'saúde'],
  },
  {
    intent: 'prazos_e_pendencias',
    gatilhos: [
      'prazo',
      'vence',
      'vencendo',
      'calendario',
      'calendário',
      'pendencia',
      'pendência',
      'atrasado',
    ],
  },
  {
    intent: 'historico_do_documento',
    gatilhos: [
      'historico',
      'histórico',
      'aconteceu com a nota',
      'aconteceu com o documento',
      'o que aconteceu com',
      'trilha da nota',
    ],
  },
  {
    intent: 'documentos_do_periodo',
    gatilhos: [
      'quantas notas',
      'quantos documentos',
      'quantas nfe',
      'notas entraram',
      'documentos entraram',
      'quantos xml',
    ],
    reforcos: ['nota', 'documento', 'entrada', 'saida', 'saída'],
  },
  {
    intent: 'valor_devido',
    gatilhos: [
      'quanto devo',
      'quanto deve',
      'valor devido',
      'devido',
      'quanto vou pagar',
      'quanto pagar',
      'quanto de ',
      'quanto da ',
      'quanto do ',
      'debito',
      'débito',
      'credito',
      'crédito',
      'apuracao',
      'apuração',
    ],
    reforcos: ['icms', 'cbs', 'ibs', 'pis', 'cofins', 'ipi'],
  },
  {
    intent: 'estado_da_competencia',
    gatilhos: [
      'em que pe',
      'em que pé',
      'estado da competencia',
      'estado da competência',
      'situacao da competencia',
      'situação da competência',
      'ja fechou',
      'já fechou',
      'esta fechada',
      'está fechada',
      'falta o que',
      'o que falta',
      'posso fechar',
      'posso confirmar',
    ],
  },
];

const TRIBUTOS = ['icms', 'ipi', 'pis', 'cofins', 'cbs', 'ibs_uf', 'ibs_mun', 'ibs'] as const;

export function classify(question: string): Classification {
  const normalizada = normalizar(question);

  const period = extrairCompetencia(question);
  const accessKey = extrairChave(question);
  const tax = TRIBUTOS.find((t) => normalizada.includes(t.replace('_', ' ')) || normalizada.includes(t));

  for (const regra of REGRAS) {
    const gatilhos = regra.gatilhos.filter((g) => normalizada.includes(normalizar(g)));
    if (gatilhos.length === 0) {
      continue;
    }

    const reforcos = (regra.reforcos ?? []).filter((r) => normalizada.includes(normalizar(r)));

    return {
      intent: regra.intent,
      ...(period === undefined ? {} : { period }),
      ...(accessKey === undefined ? {} : { accessKey }),
      ...(tax === undefined ? {} : { tax }),
      matched: [...gatilhos, ...reforcos],
    };
  }

  /**
   * Uma chave de acesso sozinha na pergunta é sinal suficiente: só existe uma
   * coisa a dizer sobre um documento específico, que é o histórico dele.
   */
  if (accessKey !== undefined) {
    return { intent: 'historico_do_documento', accessKey, matched: ['chave de acesso'] };
  }

  /**
   * O que foi extraído da pergunta vale mesmo sem intenção reconhecida: são
   * fatos sobre o texto, não sobre a interpretação dele. "E o CBS?" é uma
   * pergunta de acompanhamento que este classificador não resolve — ele não tem
   * o contexto da conversa — mas o tributo está ali e a tela pode usá-lo para
   * oferecer a pergunta completa.
   */
  return {
    intent: 'desconhecido',
    ...(period === undefined ? {} : { period }),
    ...(accessKey === undefined ? {} : { accessKey }),
    ...(tax === undefined ? {} : { tax }),
    matched: [],
  };
}

/** O que o assistente sabe responder, para dizer junto com o "não entendi". */
export const PERGUNTAS_SUPORTADAS: Readonly<Record<Exclude<Intent, 'desconhecido'>, string>> = {
  estado_da_competencia: 'Em que pé está a competência e o que falta para fechá-la',
  valor_devido: 'Débito, crédito e valor devido por tributo na competência',
  por_que_nao_determinavel: 'Por que um valor devido saiu como não determinável',
  divergencias_do_fisco: 'Onde a proposta do Fisco discorda da nossa apuração e a causa provável',
  saude_do_cadastro: 'Quais itens estão mal classificados e quantas notas cada um contaminou',
  documentos_do_periodo: 'Quantos documentos entraram na competência, por sentido',
  historico_do_documento: 'O que aconteceu com uma nota específica, pelo log de eventos',
  prazos_e_pendencias: 'Prazos a vencer e pendências da carteira',
};

// ------------------------------------------------------------- extratores

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MESES: Readonly<Record<string, string>> = {
  janeiro: '01',
  fevereiro: '02',
  marco: '03',
  abril: '04',
  maio: '05',
  junho: '06',
  julho: '07',
  agosto: '08',
  setembro: '09',
  outubro: '10',
  novembro: '11',
  dezembro: '12',
};

function extrairCompetencia(question: string): string | undefined {
  const iso = /\b(\d{4})-(0[1-9]|1[0-2])\b/.exec(question);
  if (iso) {
    return `${iso[1]}-${iso[2]}`;
  }

  // `09/2027` e `9/2027`, na ordem em que se escreve em português.
  const barra = /\b(0?[1-9]|1[0-2])\/(\d{4})\b/.exec(question);
  if (barra) {
    return `${barra[2]}-${barra[1]!.padStart(2, '0')}`;
  }

  const normalizada = normalizar(question);
  for (const [nome, numero] of Object.entries(MESES)) {
    if (!normalizada.includes(nome)) {
      continue;
    }
    const ano = /\b(20\d{2})\b/.exec(question);
    // Mês sem ano fica sem competência: assumir o ano corrente responderia
    // sobre um mês que o usuário não pediu.
    if (ano) {
      return `${ano[1]}-${numero}`;
    }
  }

  return undefined;
}

/**
 * Junta os separadores que aparecem **entre dígitos** e só depois procura os 44.
 *
 * Tirar todo espaço da frase colava a chave na palavra anterior, e `\b` entre
 * `m` e `3` não é fronteira nenhuma — a chave de "com 3527…" sumia. O limite
 * agora é por dígito, não por caractere de palavra.
 */
function extrairChave(question: string): string | undefined {
  const juntada = question.replace(/(?<=\d)[\s.\-/]+(?=\d)/g, '');
  const numerica = /(?<!\d)(\d{44})(?!\d)/.exec(juntada)?.[1];
  if (numerica !== undefined) {
    return numerica;
  }

  // Chave com CNPJ alfanumérico: letras nas 12 posições do emitente. Digitada
  // em grupos ("3527 11AB 12CD…"), um grupo termina em letra e o seguinte
  // começa em dígito, e juntar só entre dígitos não basta. Juntar entre
  // quaisquer alfanuméricos cola a chave na palavra anterior ("com 3527…"),
  // então a janela de 44 só é aceita se o dígito verificador fechar: é isso que
  // separa a chave do texto em volta.
  const compacta = question.toUpperCase().replace(/(?<=[0-9A-Z])[\s.\-/]+(?=[0-9A-Z])/g, '');
  for (const trecho of compacta.match(/[0-9A-Z]{44,}/g) ?? []) {
    for (let i = 0; i + 44 <= trecho.length; i += 1) {
      const candidata = trecho.slice(i, i + 44);
      if (/[A-Z]/.test(candidata) && isValidAccessKey(candidata)) {
        return candidata;
      }
    }
  }
  return undefined;
}
