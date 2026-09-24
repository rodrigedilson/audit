/**
 * A EFD ICMS/IPI lida, reduzida ao que a conciliação usa.
 */
import type {
  EfdIcmsAssessment,
  EfdIcmsConsolidation,
  EfdIcmsDocument,
  EfdIcmsResult,
  EfdIpiAssessment,
} from '../ingestion/efd-icms-ipi.parser.js';

/**
 * Documento reduzido ao que as conferências usam.
 *
 * A conciliação não recebe o arquivo lido, e sim este resumo, porque ela roda
 * duas vezes: na importação, sobre o que o leitor acabou de produzir, e depois,
 * sobre o que ficou gravado. Guardar item a item custaria milhões de linhas por
 * carteira para responder às mesmas somas — e derivar a conferência na leitura,
 * em vez de congelá-la, é o que faz uma regra nova valer para arquivo antigo.
 */
export interface IcmsIpiDocumentSummary {
  /** Chave de acesso, ou modelo e número quando não há chave. */
  subject: string;
  /**
   * O analítico que a linha soma: `C190` para o C100, `C590`, `D190`, `C490`...
   * É por ele que se sabe o que a soma cobre — arquivo importado antes de um
   * registro passar a ser lido não tem linha dele, e continua não verificado.
   */
  record: string;
  operation: 'inbound' | 'outbound';
  /** `COD_SIT` cru. */
  situation: string;
  /** Distingue "soma zero" de "não veio C170", que não são a mesma coisa. */
  hasItems: boolean;
  hasAnalytics: boolean;
  itemsIcmsCents: number;
  analyticsIcmsCents: number;
  /**
   * Parte do `analyticsIcmsCents` com CFOP 1605 ou 5605 — transferência de saldo
   * devedor entre estabelecimentos, que o guia manda somar no lado oposto.
   */
  transferIcmsCents: number;
  /** `VL_ICMS` do próprio documento (C100, C500, D100, D500). */
  documentIcmsCents: number;
}

export interface IcmsIpiInput {
  period: string;
  documents: readonly IcmsIpiDocumentSummary[];
  icmsAssessment: EfdIcmsAssessment | null;
  ipiAssessment: EfdIpiAssessment | null;
  /** Registros lidos por tipo — é por eles que se sabe o que a soma não cobre. */
  recordCounts: Record<string, number>;
}

/** Reduz o arquivo lido à entrada da conciliação. */
export function summarizeEfdIcmsIpi(efd: EfdIcmsResult): IcmsIpiInput {
  return {
    period: efd.header.period,
    documents: [
      ...efd.documents.map(resumirDocumento),
      ...efd.consolidations.map(resumirConsolidacao),
    ],
    icmsAssessment: efd.icmsAssessment,
    ipiAssessment: efd.ipiAssessment,
    recordCounts: efd.counts,
  };
}

function resumirDocumento(documento: EfdIcmsDocument): IcmsIpiDocumentSummary {
  return {
    subject:
      documento.accessKey ??
      `modelo ${documento.model} nº ${documento.documentNumber ?? 's/n'}`,
    record: 'C190',
    operation: documento.operation,
    situation: documento.situation,
    hasItems: documento.items.length > 0,
    hasAnalytics: documento.analytics.length > 0,
    itemsIcmsCents: documento.items.reduce((t, i) => t + i.icms.amountCents, 0),
    analyticsIcmsCents: documento.analytics.reduce((t, a) => t + a.icmsCents, 0),
    transferIcmsCents: transferencias(documento.analytics),
    documentIcmsCents: documento.icmsCents,
  };
}

function resumirConsolidacao(c: EfdIcmsConsolidation): IcmsIpiDocumentSummary {
  const analitico = c.analytics.reduce((t, a) => t + a.icmsCents, 0);
  return {
    subject: c.subject,
    record: c.record,
    operation: c.operation,
    situation: c.situation,
    hasItems: false,
    hasAnalytics: c.analytics.length > 0,
    itemsIcmsCents: 0,
    analyticsIcmsCents: analitico,
    transferIcmsCents: transferencias(c.analytics),
    documentIcmsCents: c.documentIcmsCents ?? analitico,
  };
}

/** CFOP de transferência de saldo devedor do ICMS entre estabelecimentos. */
const CFOP_TRANSFERENCIA_DE_SALDO = new Set(['1605', '5605']);

function transferencias(analiticos: readonly { cfop: string; icmsCents: number }[]): number {
  return analiticos
    .filter((a) => CFOP_TRANSFERENCIA_DE_SALDO.has(a.cfop))
    .reduce((t, a) => t + a.icmsCents, 0);
}

