import type { Regime } from '../shared/fiscal-vocabulary.js';

/**
 * Decadência e prescrição — prazo de **direito material**.
 *
 * Distinto, de propósito, do calendário de `reconciliation/deadlines.ts`, que
 * cuida de prazo de **entrega de obrigação**: mês, dia, dia útil. Aqui o prazo
 * é plurianual, conta de um termo inicial que depende da modalidade de
 * lançamento, e — no caso da prescrição — se interrompe e se suspende. O
 * próprio cabeçalho daquele arquivo alerta contra misturar espécies de prazo,
 * porque um alvo interno passaria a ter a mesma cara de um prazo de norma.
 *
 * Os dois institutos limitam o poder do Fisco, e não o do contribuinte:
 *
 * - **Decadência** extingue o próprio crédito tributário: passado o prazo, o
 *   Fisco não pode mais constituí-lo pelo lançamento.
 * - **Prescrição** extingue a ação de cobrança: o crédito existe e não pode
 *   mais ser exigido em juízo.
 *
 * Saber a diferença é o que decide se o caminho é não pagar, impugnar ou
 * embargar — e é por isso que o produto precisa nomear qual dos dois está
 * correndo, em vez de mostrar "um prazo".
 */

export const STATUTE_KINDS = [
  /** Lançamento de ofício ou por declaração: do 1º dia do exercício seguinte. */
  'decadencia_173_i',
  /** Homologação: da ocorrência do fato gerador. É onde a carteira vive. */
  'decadencia_150_4',
  /** Prescrição da ação de cobrança: da constituição definitiva. */
  'prescricao_174',
] as const;
export type StatuteKind = (typeof STATUTE_KINDS)[number];

export const COUNTING_BASES = [
  'primeiro_dia_exercicio_seguinte',
  'fato_gerador',
  'constituicao_definitiva',
] as const;
export type CountingBasis = (typeof COUNTING_BASES)[number];

/**
 * `interrupt` **zera e reinicia**; `suspend` pausa e `resume` retoma o saldo.
 *
 * Separados de propósito: tratar parcelamento como interrupção daria ao Fisco
 * cinco anos novos onde a lei dá apenas a retomada do que sobrava — e o alerta
 * sairia anos errado, no sentido que prejudica o contribuinte.
 */
export const CLOCK_EFFECTS = ['interrupt', 'suspend', 'resume'] as const;
export type ClockEffect = (typeof CLOCK_EFFECTS)[number];

export const CLOCK_EVENT_KINDS = [
  'protesto_cda',
  'citacao_em_execucao_fiscal',
  'confissao_de_divida',
  'parcelamento_deferido',
  'parcelamento_rescindido',
  'decisao_judicial_suspensiva',
  'deposito_judicial',
  'reclamacao_ou_recurso_administrativo',
] as const;
export type ClockEventKind = (typeof CLOCK_EVENT_KINDS)[number];

export interface ClockEvent {
  kind: ClockEventKind;
  effect: ClockEffect;
  /** `YYYY-MM-DD`. */
  occurredAt: string;
  /** Base legal do efeito. Vazia é recusada: relógio sem fonte não anda. */
  legalBasis: string;
  /** `event_seq` do registro no log. É o que torna o efeito conferível. */
  eventSeq: number;
}

export interface StatuteRule {
  kind: StatuteKind;
  basis: CountingBasis;
  years: number;
  /** `true` só para prescrição: decadência não se interrompe nem se suspende. */
  interruptible: boolean;
  legalBasis: string;
  /** Conferida em texto oficial? Enquanto `false`, o prazo não é afirmado. */
  verified: boolean;
  /** Ligada? Nasce desligada: é a **aplicação** que é incerta, não o texto. */
  active: boolean;
}

/**
 * Qual artigo rege cada tributo.
 *
 * **Nasce vazio.** Se IBS e CBS seguem o art. 150, §4º — como tributo sujeito a
 * lançamento por homologação — não foi conferido em texto oficial, e a resposta
 * muda o termo inicial em um ano inteiro. Sem mapeamento, `computeStatute`
 * devolve `expiresAt: null` e o motivo, nunca uma data.
 */
export interface StatuteBasisMapping {
  tax: string;
  /** `null` = vale para todos os regimes. */
  regime: Regime | null;
  kind: StatuteKind;
  validFrom: string;
  validTo: string | null;
  legalBasis: string;
  verified: boolean;
}

export interface StatuteSnapshot {
  kind: StatuteKind;
  /** Termo inicial efetivo, já aplicadas as interrupções. */
  startsAt: string | null;
  /** `null` quando a regra ou o mapeamento não estão carregados ou conferidos. */
  expiresAt: string | null;
  /** Dias suspensos acumulados, somados ao termo final. */
  suspendedDays: number;
  /** Ordem significativa: o fold é sequencial. */
  clockEvents: readonly ClockEvent[];
  /**
   * `null` = **não calculável**. Nunca `false` por ausência de dado: "não
   * consegui calcular" saindo como "não venceu" é a forma mais cara de errar
   * aqui, porque o escritório deixaria de impugnar um crédito extinto.
   */
  expired: boolean | null;
  daysLeft: number | null;
  legalBasis: string;
  /** Obrigatório quando `expiresAt` é `null`. */
  unavailableReason: string | null;
}

export interface StatuteInput {
  rule: StatuteRule | null;
  mapping: StatuteBasisMapping | null;
  /** Competência do fato gerador, `YYYY-MM`. */
  period: string;
  /** Exigida para `prescricao_174`. `YYYY-MM-DD`. */
  definitiveConstitutionAt: string | null;
  clockEvents: readonly ClockEvent[];
  /** Data de referência, injetada. Sem relógio dentro do domínio. */
  today: string;
}

const DIA = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function somarAnos(data: string, anos: number): string {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + anos);
  return iso(d);
}

function somarDias(data: string, dias: number): string {
  return iso(new Date(new Date(`${data}T00:00:00Z`).getTime() + dias * DIA));
}

function diasEntre(de: string, ate: string): number {
  return Math.round(
    (new Date(`${ate}T00:00:00Z`).getTime() - new Date(`${de}T00:00:00Z`).getTime()) / DIA,
  );
}

/**
 * Termo inicial pela base de contagem.
 *
 * `fato_gerador` usa o **último dia** da competência: é o instante em que o
 * fato se completa para tributo apurado por período, e usar o primeiro dia
 * anteciparia o vencimento em quase um mês, contra o contribuinte.
 */
export function initialTerm(basis: CountingBasis, input: StatuteInput): string | null {
  const [ano, mes] = input.period.split('-').map(Number) as [number, number];

  switch (basis) {
    case 'primeiro_dia_exercicio_seguinte':
      return `${ano + 1}-01-01`;

    case 'fato_gerador':
      return iso(new Date(Date.UTC(ano, mes, 0)));

    case 'constituicao_definitiva':
      return input.definitiveConstitutionAt;
  }
}

/** O mapeamento vigente para o tributo e regime, ou `null`. */
export function basisFor(
  mappings: readonly StatuteBasisMapping[],
  tax: string,
  regime: Regime,
  onDate: string,
): StatuteBasisMapping | null {
  const candidatos = mappings.filter(
    (m) =>
      m.tax === tax &&
      (m.regime === null || m.regime === regime) &&
      m.validFrom <= onDate &&
      (m.validTo === null || onDate <= m.validTo),
  );

  // O mapeamento específico do regime vence o genérico.
  return candidatos.find((m) => m.regime !== null) ?? candidatos[0] ?? null;
}

function indisponivel(
  kind: StatuteKind,
  clockEvents: readonly ClockEvent[],
  legalBasis: string,
  reason: string,
): StatuteSnapshot {
  return {
    kind,
    startsAt: null,
    expiresAt: null,
    suspendedDays: 0,
    clockEvents,
    expired: null,
    daysLeft: null,
    legalBasis,
    unavailableReason: reason,
  };
}

/**
 * Aplica as regras e os atos sobre o relógio. Puro e determinístico.
 *
 * Os atos são aplicados em ordem cronológica, e a ordem importa: interromper
 * depois de suspender descarta a suspensão, porque o prazo reiniciou.
 */
export function computeStatute(input: StatuteInput): StatuteSnapshot {
  const { rule, mapping, clockEvents } = input;

  if (rule === null) {
    return indisponivel(
      'decadencia_150_4',
      clockEvents,
      '',
      'A regra do prazo não está carregada.',
    );
  }

  if (!rule.active || !rule.verified) {
    return indisponivel(
      rule.kind,
      clockEvents,
      rule.legalBasis,
      'A regra do prazo não foi conferida em texto oficial e está desligada: ' +
        'alertar na data errada é pior do que não alertar.',
    );
  }

  if (mapping === null || !mapping.verified) {
    return indisponivel(
      rule.kind,
      clockEvents,
      rule.legalBasis,
      'Não há mapeamento conferido dizendo qual artigo rege este tributo. ' +
        'A resposta muda o termo inicial em um ano inteiro.',
    );
  }

  const termo = initialTerm(rule.basis, input);
  if (termo === null) {
    return indisponivel(
      rule.kind,
      clockEvents,
      rule.legalBasis,
      rule.basis === 'constituicao_definitiva'
        ? 'A prescrição conta da constituição definitiva, e ela não foi informada.'
        : 'Não foi possível derivar o termo inicial.',
    );
  }

  const ordenados = [...clockEvents].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  let inicio = termo;
  let suspensos = 0;
  let suspensoDesde: string | null = null;

  if (rule.interruptible) {
    for (const ato of ordenados) {
      switch (ato.effect) {
        case 'interrupt':
          // Zera: o prazo recomeça do ato, e a suspensão pendente perde objeto.
          inicio = ato.occurredAt;
          suspensos = 0;
          suspensoDesde = null;
          break;

        case 'suspend':
          suspensoDesde ??= ato.occurredAt;
          break;

        case 'resume':
          if (suspensoDesde !== null) {
            suspensos += diasEntre(suspensoDesde, ato.occurredAt);
            suspensoDesde = null;
          }
          break;
      }
    }

    // Suspensão ainda aberta conta até hoje: o prazo está parado agora.
    if (suspensoDesde !== null) {
      suspensos += diasEntre(suspensoDesde, input.today);
    }
  }

  const vencimento = somarDias(somarAnos(inicio, rule.years), suspensos);

  return {
    kind: rule.kind,
    startsAt: inicio,
    expiresAt: vencimento,
    suspendedDays: suspensos,
    clockEvents: ordenados,
    expired: input.today > vencimento,
    daysLeft: diasEntre(input.today, vencimento),
    legalBasis: rule.legalBasis,
    unavailableReason: null,
  };
}

/**
 * As três regras do CTN, como o produto as entende.
 *
 * Nascem **conferidas no texto** (`verified: true` só onde a leitura do artigo
 * é direta) e **desligadas** (`active: false`). A distinção é deliberada: o
 * prazo de cinco anos e a base de contagem estão escritos no CTN; o que não
 * está conferido é a **aplicação** a cada tributo — e é por isso que ligar cada
 * regra continua sendo ato humano, e o mapeamento por tributo nasce vazio.
 */
export const REGRAS_CTN: readonly StatuteRule[] = [
  {
    kind: 'decadencia_173_i',
    basis: 'primeiro_dia_exercicio_seguinte',
    years: 5,
    interruptible: false,
    legalBasis: 'CTN, art. 173, I',
    verified: true,
    active: false,
  },
  {
    kind: 'decadencia_150_4',
    basis: 'fato_gerador',
    years: 5,
    interruptible: false,
    legalBasis: 'CTN, art. 150, §4º',
    verified: true,
    active: false,
  },
  {
    kind: 'prescricao_174',
    basis: 'constituicao_definitiva',
    years: 5,
    interruptible: true,
    legalBasis: 'CTN, art. 174',
    verified: true,
    active: false,
  },
];
