import type { PeriodState, Regime } from '../shared/fiscal-vocabulary.js';

/**
 * Calendário da carteira.
 *
 * Duas naturezas que o módulo mantém **separadas de propósito**:
 *
 * - **Prazo** tem data e base legal. Perder um tem consequência jurídica.
 * - **Pendência** sai do estado do sistema: competência do mês passado ainda
 *   aberta, proposta do Fisco sem contestação. Não tem data de lei nenhuma.
 *
 * Misturar as duas faria um alvo interno do escritório aparecer com a mesma
 * cara de um prazo de norma, e o contador trataria os dois igual — errando por
 * excesso num caso e por omissão no outro.
 *
 * As pendências não são persistidas: são função do estado de agora, e uma tabela
 * de pendências ficaria velha entre o cálculo e a leitura.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type PendencyKind =
  /** Mês encerrado e a competência nunca foi apurada. */
  | 'competencia_nao_apurada'
  /** Apurada e não confirmada: sem confirmação não há hash de fechamento. */
  | 'apuracao_nao_confirmada'
  /**
   * Proposta do Fisco com divergência grave e a competência não voltou a ser
   * trabalhada. É o caso que o produto existe para pegar: na apuração assistida
   * o silêncio vale como concordância.
   */
  | 'proposta_do_fisco_sem_resposta'
  /** Proposta só com totais: nada foi comparado nota a nota. */
  | 'proposta_do_fisco_sem_detalhe';

export interface Pendency {
  kind: PendencyKind;
  cnpj: string;
  period: string;
  name: string
  message: string;
  severity: Severity;
  /** Desde quando está assim. Substitui a data de vencimento, que não existe. */
  openSince: string;
  daysOpen: number;
}

export interface PeriodSnapshot {
  cnpj: string;
  period: string;
  state: PeriodState;
  regime: Regime;
  /** Quando a competência foi aberta, em ISO. */
  openedAt: string;
  fisco?: {
    uploadedAt: string;
    lineLevel: boolean;
    criticalDivergences: number;
    highDivergences: number;
  };
}

export interface PendencyInput {
  periods: readonly PeriodSnapshot[];
  today: Date;
}

/**
 * Dias corridos a partir dos quais a pendência sobe de gravidade.
 *
 * São limiares **nossos**, não prazos de lei: servem para ordenar a fila de
 * trabalho do escritório. Quando `deadline_rules` tiver prazo normativo
 * carregado, é ele que manda, e estes continuam só priorizando.
 */
export const LIMIARES_DE_GRAVIDADE = { medium: 15, high: 45, critical: 90 } as const;

export function derivePendencies(input: PendencyInput): Pendency[] {
  const saida: Pendency[] = [];

  for (const periodo of input.periods) {
    saida.push(...doEstadoDaCompetencia(periodo, input.today));
    saida.push(...daPropostaDoFisco(periodo, input.today));
  }

  return saida.sort(ordenarPorGravidade);
}

function doEstadoDaCompetencia(periodo: PeriodSnapshot, hoje: Date): Pendency[] {
  // Competência do mês corrente não é pendência: ainda há documento chegando.
  const fim = fimDaCompetencia(periodo.period);
  if (fim >= hoje) {
    return [];
  }

  const dias = diasEntre(fim, hoje);

  if (periodo.state === 'open') {
    return [
      {
        kind: 'competencia_nao_apurada',
        cnpj: periodo.cnpj,
        period: periodo.period,
        name: 'Competência encerrada e não apurada',
        message:
          `A competência ${periodo.period} terminou há ${dias} dia(s) e continua aberta. ` +
          'Sem apuração não há débito, crédito nem comparação com o Fisco.',
        severity: gravidadePorIdade(dias),
        openSince: fim.toISOString(),
        daysOpen: dias,
      },
    ];
  }

  if (periodo.state === 'assessed' || periodo.state === 'reconciled') {
    return [
      {
        kind: 'apuracao_nao_confirmada',
        cnpj: periodo.cnpj,
        period: periodo.period,
        name: 'Apuração não confirmada',
        message:
          `A competência ${periodo.period} está ${periodo.state === 'assessed' ? 'apurada' : 'conciliada'} ` +
          `há ${dias} dia(s) e não foi confirmada. Sem confirmação não há hash de ` +
          'fechamento, e portanto não há trilha de defesa para os números do mês.',
        severity: gravidadePorIdade(dias),
        openSince: fim.toISOString(),
        daysOpen: dias,
      },
    ];
  }

  return [];
}

function daPropostaDoFisco(periodo: PeriodSnapshot, hoje: Date): Pendency[] {
  const { fisco } = periodo;
  if (!fisco) {
    return [];
  }

  const recebida = new Date(fisco.uploadedAt);
  const dias = diasEntre(recebida, hoje);
  const saida: Pendency[] = [];

  const graves = fisco.criticalDivergences + fisco.highDivergences;

  /**
   * Divergência grave em pé e competência já confirmada significa que o
   * escritório fechou o mês **depois** de ver a proposta: é uma decisão
   * registrada, não uma omissão.
   */
  if (graves > 0 && periodo.state !== 'confirmed') {
    saida.push({
      kind: 'proposta_do_fisco_sem_resposta',
      cnpj: periodo.cnpj,
      period: periodo.period,
      name: 'Proposta do Fisco com divergência grave e sem resposta',
      message:
        `A proposta do Fisco para ${periodo.period} chegou há ${dias} dia(s) com ` +
        `${fisco.criticalDivergences} divergência(s) crítica(s) e ${fisco.highDivergences} ` +
        'alta(s), e a competência não foi fechada depois disso. Na apuração assistida ' +
        'o silêncio do contribuinte é tratado como concordância.',
      // Sempre crítica: a consequência não depende de há quantos dias está
      // parada, e rebaixá-la nos primeiros dias faria o alerta surgir tarde.
      severity: 'critical',
      openSince: recebida.toISOString(),
      daysOpen: dias,
    });
  }

  if (!fisco.lineLevel) {
    saida.push({
      kind: 'proposta_do_fisco_sem_detalhe',
      cnpj: periodo.cnpj,
      period: periodo.period,
      name: 'Proposta do Fisco sem detalhe nota a nota',
      message:
        `A proposta de ${periodo.period} veio só com totais por tributo. A comparação ` +
        'nota a nota não foi feita: a ausência de divergência de item aqui não ' +
        'significa que as notas conferem.',
      severity: 'medium',
      openSince: recebida.toISOString(),
      daysOpen: dias,
    });
  }

  return saida;
}

// --------------------------------------------------- prazos normativos

/**
 * Como o dia do mês se transforma em data.
 *
 * Existe porque os dois prazos que mais importam **não são dia de calendário**,
 * e datá-los como se fossem colocaria data errada ao lado de uma citação legal:
 *
 * - `exact` — o dia é o dia. Prazo que não se move.
 * - `nth_business_day` — o N-ésimo dia útil do mês. É o caso da
 *   EFD-Contribuições: décimo dia útil do segundo mês subsequente.
 * - `anticipate_to_business_day` — o dia fixo, **antecipado** para o dia útil
 *   anterior quando cai em fim de semana ou feriado. É o caso do DAS: dia 20,
 *   antecipado. Aqui errar para frente é perigoso — diria ao contador que ele
 *   tem até dia 20 quando o pagamento venceu no 18.
 */
export type DayRule = 'exact' | 'nth_business_day' | 'anticipate_to_business_day';

export interface DeadlineRule {
  ruleId: string;
  name: string;
  description: string;
  appliesToRegimes: readonly Regime[] | null;
  monthsAfter: number | null;
  dayOfMonth: number | null;
  /** Como `dayOfMonth` vira data. Ver `DayRule`. */
  dayRule: DayRule;
  fixedDate: string | null;
  warnDays: number;
  severity: Severity;
  legalBasis: string;
}

export interface DatedDeadline {
  ruleId: string | null;
  kind: string;
  name: string;
  cnpj: string;
  period: string | null;
  dueDate: string;
  severity: Severity;
  nature: 'normativo' | 'fato';
  legalBasis: string | null;
}

/**
 * Datas concretas a partir das regras normativas.
 *
 * `deadline_rules` nasce **vazia**, e por isso esta função devolve lista vazia
 * num sistema recém-instalado. Isso é correto e é o motivo de a API expor
 * `normative_rules_loaded`: lista vazia de prazo não é "nenhum prazo a vencer",
 * é "nenhum prazo carregado".
 */
export function deriveDeadlines(
  rules: readonly DeadlineRule[],
  periods: readonly PeriodSnapshot[],
): DatedDeadline[] {
  const saida: DatedDeadline[] = [];

  for (const regra of rules) {
    for (const periodo of periods) {
      if (regra.appliesToRegimes && !regra.appliesToRegimes.includes(periodo.regime)) {
        continue;
      }

      const data = dataDaRegra(regra, periodo.period);
      if (data === null) {
        continue;
      }

      saida.push({
        ruleId: regra.ruleId,
        kind: regra.ruleId,
        name: regra.name,
        cnpj: periodo.cnpj,
        period: periodo.period,
        dueDate: data,
        severity: regra.severity,
        nature: 'normativo',
        legalBasis: regra.legalBasis,
      });
    }
  }

  return saida.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function dataDaRegra(regra: DeadlineRule, period: string): string | null {
  if (regra.fixedDate !== null) {
    return regra.fixedDate;
  }

  if (regra.monthsAfter === null || regra.dayOfMonth === null) {
    return null;
  }

  const [ano, mes] = period.split('-').map(Number) as [number, number];
  const alvo = new Date(Date.UTC(ano, mes - 1 + regra.monthsAfter, 1));
  const anoAlvo = alvo.getUTCFullYear();
  const mesAlvo = alvo.getUTCMonth();

  if (regra.dayRule === 'nth_business_day') {
    return iso(nEsimoDiaUtil(anoAlvo, mesAlvo, regra.dayOfMonth));
  }

  // Dia 31 num mês de 30 cai no último dia do mês, e não escorrega para o mês
  // seguinte: prazo do mês X não vence no mês X+1.
  const ultimoDia = new Date(Date.UTC(anoAlvo, mesAlvo + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(regra.dayOfMonth, ultimoDia));

  return iso(
    regra.dayRule === 'anticipate_to_business_day' ? diaUtilAnterior(alvo) : alvo,
  );
}

// --------------------------------------------------------- dias úteis

/**
 * Feriados considerados no cálculo de dia útil.
 *
 * São os **nacionais**, e o conjunto inclui Carnaval e Corpus Christi, que
 * legalmente são ponto facultativo e não feriado. A razão é prática e está do
 * lado seguro: a rede bancária não opera nesses dias, e para prazo de pagamento
 * é a operação bancária que manda. Contá-los antecipa a data calculada, e
 * antecipar é o erro tolerável — o intolerável é dizer que ainda há prazo
 * quando não há.
 *
 * **O que este cálculo não sabe:** feriado estadual e municipal. Um prazo pode
 * na prática cair um dia antes do que sai daqui, numa praça com feriado local.
 * O alerta dispara cedo nesse caso, nunca tarde.
 *
 * Base dos nacionais: Lei 662/1949, Lei 6.802/1980 (Aparecida) e Lei
 * 14.759/2023 (Consciência Negra). Os móveis derivam da Páscoa.
 */
const FERIADOS_FIXOS: readonly [number, number][] = [
  [0, 1], // Confraternização Universal
  [3, 21], // Tiradentes
  [4, 1], // Dia do Trabalho
  [8, 7], // Independência
  [9, 12], // Nossa Senhora Aparecida
  [10, 2], // Finados
  [10, 15], // Proclamação da República
  [10, 20], // Consciência Negra
  [11, 25], // Natal
];

/** Domingo de Páscoa pelo algoritmo de Meeus/Jones/Butcher. */
function pascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

function somarDias(data: Date, dias: number): Date {
  return new Date(data.getTime() + dias * 86_400_000);
}

const feriadosPorAno = new Map<number, Set<string>>();

function feriadosDe(ano: number): Set<string> {
  const cache = feriadosPorAno.get(ano);
  if (cache !== undefined) {
    return cache;
  }

  const datas = new Set<string>();
  for (const [mes, dia] of FERIADOS_FIXOS) {
    datas.add(iso(new Date(Date.UTC(ano, mes, dia))));
  }

  const domingoDePascoa = pascoa(ano);
  // Carnaval (terça), Sexta-feira Santa e Corpus Christi.
  for (const deslocamento of [-47, -2, 60]) {
    datas.add(iso(somarDias(domingoDePascoa, deslocamento)));
  }

  feriadosPorAno.set(ano, datas);
  return datas;
}

function ehDiaUtil(data: Date): boolean {
  const diaDaSemana = data.getUTCDay();
  if (diaDaSemana === 0 || diaDaSemana === 6) {
    return false;
  }
  return !feriadosDe(data.getUTCFullYear()).has(iso(data));
}

/**
 * O N-ésimo dia útil do mês.
 *
 * Quando o mês não tem N dias úteis — não acontece com N até 18, mas a função
 * não presume —, devolve o último dia útil do mês em vez de escorregar para o
 * mês seguinte: prazo do mês X não vence em X+1.
 */
function nEsimoDiaUtil(ano: number, mes: number, n: number): Date {
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  let contados = 0;
  let ultimoUtil = new Date(Date.UTC(ano, mes, 1));

  for (let dia = 1; dia <= ultimo; dia += 1) {
    const candidato = new Date(Date.UTC(ano, mes, dia));
    if (ehDiaUtil(candidato)) {
      ultimoUtil = candidato;
      contados += 1;
      if (contados === n) {
        return candidato;
      }
    }
  }

  return ultimoUtil;
}

/** A própria data, ou o dia útil imediatamente anterior. */
function diaUtilAnterior(data: Date): Date {
  let candidato = data;
  while (!ehDiaUtil(candidato)) {
    candidato = somarDias(candidato, -1);
  }
  return candidato;
}

function iso(data: Date): string {
  return data.toISOString().slice(0, 10);
}

// ------------------------------------------------------------ utilidades

const ORDEM: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function ordenarPorGravidade(a: Pendency, b: Pendency): number {
  const porGravidade = ORDEM[a.severity] - ORDEM[b.severity];
  return porGravidade !== 0 ? porGravidade : b.daysOpen - a.daysOpen;
}

function gravidadePorIdade(dias: number): Severity {
  if (dias >= LIMIARES_DE_GRAVIDADE.critical) return 'critical';
  if (dias >= LIMIARES_DE_GRAVIDADE.high) return 'high';
  if (dias >= LIMIARES_DE_GRAVIDADE.medium) return 'medium';
  return 'low';
}

/** Último instante da competência, em UTC. */
function fimDaCompetencia(period: string): Date {
  const [ano, mes] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(ano, mes, 0, 23, 59, 59, 999));
}

function diasEntre(de: Date, ate: Date): number {
  return Math.max(0, Math.floor((ate.getTime() - de.getTime()) / 86_400_000));
}
