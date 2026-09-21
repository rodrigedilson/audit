import type { SpedCarriedCredit, SpedDocument } from './sped-parser.js';

/**
 * Lastro documental do crédito de PIS/Cofins — diferencial #9.
 *
 * A tese comercial: crédito sem lastro documental será perdido no pente-fino, e
 * a Nota Técnica RFB 011/2026 restringe a EFD-Contribuições a retificação e
 * saldos a partir de 2027 — o que faz do saldo credor acumulado um ativo com
 * prazo para ser defendido.
 *
 * **A honestidade central desta onda:** a ausência de um documento na nossa base
 * não prova que o crédito é indevido. Se o escritório só começou a ingerir XML
 * em 2026, um crédito de 2023 não tem como ser conferido aqui — e reportá-lo
 * como "sem documento" seria acusar o cliente de um problema que é nosso.
 *
 * Daí a janela de cobertura: competência fora dela vira `nao_verificavel`, que é
 * um estado de primeira classe e não um `sem_documento` disfarçado. É a mesma
 * regra do `not_verified` do catálogo e do `not_applicable` das trilhas.
 */

export type BackingStatus =
  /** Documento na base, com os valores de PIS/Cofins conferindo. */
  | 'lastreado'
  /** Documento na base, e os valores divergem do que a EFD declarou. */
  | 'divergente'
  /** Documento declarado na EFD e ausente da nossa base, dentro da cobertura. */
  | 'sem_documento'
  /** Competência fora da janela de cobertura: não há como conferir. */
  | 'nao_verificavel'
  /** Documento sem chave de acesso — nota em papel, por exemplo. */
  | 'sem_chave';

export interface CoverageWindow {
  /** Competências em que a nossa base tem documento. */
  periods: ReadonlySet<string>;
  /** Primeira e última competência com documento, para a mensagem. */
  from: string | null;
  to: string | null;
}

/** Documento da nossa base, com os valores de PIS/Cofins somados. */
export interface OwnDocument {
  accessKey: string;
  period: string;
  pisCents: number;
  cofinsCents: number;
}

export interface BackingCheck {
  accessKey: string | null;
  /** Competência da EFD em que o documento foi escriturado. */
  period: string;
  documentNumber: string | null;
  status: BackingStatus;
  reason: string;
  /** O que a EFD declarou. */
  declared: { pisCents: number; cofinsCents: number };
  /** O que a nossa base tem; `null` quando não há documento. */
  found: { pisCents: number; cofinsCents: number } | null;
  differenceCents: number;
}

export interface CarriedCreditAssessment extends SpedCarriedCredit {
  /**
   * Se a competência de origem do crédito está dentro da cobertura.
   *
   * `false` não diz nada sobre o crédito: diz que este sistema não tem os
   * documentos daquele mês.
   */
  withinCoverage: boolean;
  note: string;
}

export interface DossierSummary {
  documentsChecked: number;
  lastreado: number;
  divergente: number;
  sem_documento: number;
  nao_verificavel: number;
  sem_chave: number;
  /** Crédito declarado nos documentos conferidos e conferentes. */
  backedCents: number;
  /** Crédito declarado em documento ausente, dentro da cobertura. */
  unbackedCents: number;
  /** Crédito declarado em competência fora da cobertura. */
  unverifiableCents: number;
  divergentCents: number;
  /** Saldo credor final declarado na EFD, somado por tributo. */
  carriedBalanceCents: { pis: number; cofins: number };
  /** Fração do saldo credor cuja competência de origem está coberta. */
  carriedWithinCoverageRatio: number;
}

export interface DossierInput {
  /** Documentos de entrada escriturados na EFD; só a entrada gera crédito. */
  spedDocuments: readonly SpedDocument[];
  carriedCredits: readonly SpedCarriedCredit[];
  ownDocuments: readonly OwnDocument[];
  coverage: CoverageWindow;
  /** Competência da escrituração. */
  period: string;
  /** Tolerância por documento, em centavos. */
  toleranceCents?: number;
}

export interface DossierResult {
  checks: BackingCheck[];
  carried: CarriedCreditAssessment[];
  summary: DossierSummary;
}

/** Um centavo por documento: abaixo disso é arredondamento de escrituração. */
export const TOLERANCIA_PADRAO_CENTAVOS = 1;

/** Limite de documentos no detalhe; o resumo continua exato. */
export const MAX_CHECKS_DETALHADOS = 1_000;

export function buildDossier(input: DossierInput): DossierResult {
  const tolerancia = input.toleranceCents ?? TOLERANCIA_PADRAO_CENTAVOS;
  const nossos = new Map(input.ownDocuments.map((d) => [d.accessKey, d]));

  const checks = input.spedDocuments
    // Só a entrada gera crédito: conferir a saída aqui reportaria o débito do
    // cliente como crédito sem lastro.
    .filter((d) => d.operation === 'inbound')
    .map((documento) => conferir(documento, nossos, input, tolerancia));

  const carried = input.carriedCredits.map((credito) => avaliarSaldo(credito, input.coverage));

  return {
    checks: checks.slice(0, MAX_CHECKS_DETALHADOS),
    carried,
    summary: resumir(checks, carried),
  };
}

function conferir(
  documento: SpedDocument,
  nossos: ReadonlyMap<string, OwnDocument>,
  input: DossierInput,
  tolerancia: number,
): BackingCheck {
  const declarado = somarDocumento(documento);
  const base = {
    accessKey: documento.accessKey,
    period: input.period,
    documentNumber: documento.documentNumber,
    declared: declarado,
  };

  /**
   * Nota sem chave de acesso não é erro: documento em papel existe. Mas também
   * não há como casá-la com a nossa base, e tratá-la como "sem documento"
   * acusaria o cliente de uma limitação do formato.
   */
  if (documento.accessKey === null) {
    return {
      ...base,
      status: 'sem_chave',
      reason:
        'O documento escriturado não traz chave de acesso — nota em papel, por ' +
        'exemplo. Não há como conferi-lo contra a base de XML, e isso não é ' +
        'indício de crédito indevido.',
      found: null,
      differenceCents: 0,
    };
  }

  const nosso = nossos.get(documento.accessKey);

  if (nosso === undefined) {
    /**
     * A distinção que faz o dossiê ser defensável: fora da cobertura, a ausência
     * é nossa e não do cliente.
     */
    if (!input.coverage.periods.has(input.period)) {
      return {
        ...base,
        status: 'nao_verificavel',
        reason:
          `A competência ${input.period} está fora da janela em que este sistema tem ` +
          `documentos (${descreverCobertura(input.coverage)}). A ausência do XML aqui ` +
          'é limitação da nossa coleta, não indício de crédito indevido.',
        found: null,
        differenceCents: 0,
      };
    }

    return {
      ...base,
      status: 'sem_documento',
      reason:
        'O crédito foi escriturado e o XML não está na base, embora a competência ' +
        'esteja coberta. É o caso que o pente-fino cobra: ou o documento é ' +
        'localizado, ou o crédito não tem como ser defendido.',
      found: null,
      differenceCents: 0,
    };
  }

  const encontrado = { pisCents: nosso.pisCents, cofinsCents: nosso.cofinsCents };
  const diferenca =
    encontrado.pisCents +
    encontrado.cofinsCents -
    (declarado.pisCents + declarado.cofinsCents);

  if (Math.abs(diferenca) > tolerancia) {
    return {
      ...base,
      status: 'divergente',
      reason:
        'O XML está na base e os valores de PIS/Cofins divergem do que a EFD ' +
        'declarou. Vale conferir qual dos dois está certo antes de defender o ' +
        'crédito — a divergência aparece no cruzamento que a RFB faz.',
      found: encontrado,
      differenceCents: diferenca,
    };
  }

  return {
    ...base,
    status: 'lastreado',
    reason: 'O XML está na base e os valores de PIS/Cofins conferem com a EFD.',
    found: encontrado,
    differenceCents: diferenca,
  };
}

function avaliarSaldo(
  credito: SpedCarriedCredit,
  coverage: CoverageWindow,
): CarriedCreditAssessment {
  const dentro = coverage.periods.has(credito.originPeriod);

  return {
    ...credito,
    withinCoverage: dentro,
    note: dentro
      ? `A competência de origem ${credito.originPeriod} está coberta: o lastro dos ` +
        'documentos daquele mês pode ser conferido neste sistema.'
      : `A competência de origem ${credito.originPeriod} está fora da janela coberta ` +
        `(${descreverCobertura(coverage)}). Defender este saldo exige recuperar os ` +
        'documentos daquele período — o sistema não tem como confirmá-lo nem negá-lo.',
  };
}

function somarDocumento(documento: SpedDocument): {
  pisCents: number;
  cofinsCents: number;
} {
  return documento.items.reduce(
    (soma, item) => ({
      pisCents: soma.pisCents + item.pis.amountCents,
      cofinsCents: soma.cofinsCents + item.cofins.amountCents,
    }),
    { pisCents: 0, cofinsCents: 0 },
  );
}

function resumir(
  checks: readonly BackingCheck[],
  carried: readonly CarriedCreditAssessment[],
): DossierSummary {
  const contar = (status: BackingStatus): number =>
    checks.filter((c) => c.status === status).length;

  const somar = (status: BackingStatus): number =>
    checks
      .filter((c) => c.status === status)
      .reduce((s, c) => s + c.declared.pisCents + c.declared.cofinsCents, 0);

  const saldoDe = (tax: 'pis' | 'cofins'): number =>
    carried.filter((c) => c.tax === tax).reduce((s, c) => s + c.finalBalanceCents, 0);

  const saldoTotal = carried.reduce((s, c) => s + c.finalBalanceCents, 0);
  const saldoCoberto = carried
    .filter((c) => c.withinCoverage)
    .reduce((s, c) => s + c.finalBalanceCents, 0);

  return {
    documentsChecked: checks.length,
    lastreado: contar('lastreado'),
    divergente: contar('divergente'),
    sem_documento: contar('sem_documento'),
    nao_verificavel: contar('nao_verificavel'),
    sem_chave: contar('sem_chave'),
    backedCents: somar('lastreado'),
    unbackedCents: somar('sem_documento'),
    // `sem_chave` entra aqui e não em `unbacked`: também não foi conferido, e
    // somá-lo ao não lastreado acusaria o cliente por nota em papel.
    unverifiableCents: somar('nao_verificavel') + somar('sem_chave'),
    divergentCents: somar('divergente'),
    carriedBalanceCents: { pis: saldoDe('pis'), cofins: saldoDe('cofins') },
    // Zero saldo não é "zero por cento coberto": é nada a cobrir.
    carriedWithinCoverageRatio: saldoTotal === 0 ? 1 : saldoCoberto / saldoTotal,
  };
}

function descreverCobertura(coverage: CoverageWindow): string {
  if (coverage.from === null || coverage.to === null) {
    return 'nenhuma competência com documento ingerido';
  }
  return coverage.from === coverage.to
    ? `apenas ${coverage.from}`
    : `de ${coverage.from} a ${coverage.to}`;
}
