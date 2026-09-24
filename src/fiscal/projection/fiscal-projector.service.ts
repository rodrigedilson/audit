import type { ESAAEventData } from '../../esaa/shared/types/esaa-event.types.js';
import { hashProjection } from '../../esaa/shared/infrastructure/crypto-utils.js';
import type { FiscalAction, PeriodState } from '../shared/fiscal-vocabulary.js';
import { CREDIT_STATES } from '../shared/fiscal-vocabulary.js';
import type {
  CatalogProjection,
  ClientAlertPayload,
  ClientEnrolledPayload,
  ClientUpdatedPayload,
  CertificateStoredPayload,
  CertificateUsedPayload,
  FiscalProjection,
  ItemClassifiedPayload,
  PeriodClosedPayload,
  PeriodOpenedPayload,
  RectificationFiledPayload,
  AssessmentConfirmedPayload,
} from '../shared/fiscal-projection.types.js';

export const FISCAL_SCHEMA_VERSION = '0.5.0';

/**
 * `last_updated` de um log sem eventos. Constante, não `new Date()`: sem isso
 * duas projeções do mesmo log vazio rendem hashes diferentes e `POST /verify` de
 * um CNPJ recém-cadastrado acusaria divergência. Mesmo motivo do projetor
 * anterior; o defeito não volta porque há teste.
 */
export const EMPTY_PROJECTION_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export class ProjectionError extends Error {
  constructor(action: never, eventSeq: number) {
    super(
      `Projeção interrompida: ação desconhecida '${String(action)}' no evento seq ${eventSeq}`,
    );
    this.name = 'ProjectionError';
  }
}

/**
 * Projeta o event log de um CNPJ no seu estado atual. Determinístico: os mesmos
 * eventos, na mesma ordem, produzem sempre o mesmo objeto e o mesmo hash — é o
 * que dá ao contador uma trilha que ele consegue defender (INV-006).
 */
export class FiscalProjectorService {
  project(tenantId: string, cnpj: string, events: readonly ESAAEventData[]): FiscalProjection {
    const projection: FiscalProjection = {
      schema_version: FISCAL_SCHEMA_VERSION,
      projection_hash_sha256: '',
      last_event_seq: -1,
      last_updated: EMPTY_PROJECTION_TIMESTAMP,
      tenant_id: tenantId,
      cnpj,
      client: null,
      periods: {},
      certificate: null,
      catalog: emptyCatalog(),
      alerts: [],
      issues: [],
      stats: emptyStats(),
    };

    for (const event of events) {
      this.apply(projection, event);
      projection.last_event_seq = event.event_seq;
      projection.last_updated = event.ts;
    }

    this.recalculateStats(projection);

    const { projection_hash_sha256: _ignored, ...dataToHash } = projection;
    projection.projection_hash_sha256 = hashProjection(dataToHash);

    return projection;
  }

  private apply(projection: FiscalProjection, event: ESAAEventData): void {
    switch (event.action as FiscalAction) {
      // ------------------------------------------------ portfolio (Onda 2)
      case 'client.enrolled':
        this.applyClientEnrolled(projection, event);
        break;
      case 'client.updated':
        this.applyClientUpdated(projection, event);
        break;
      case 'client.alert':
        this.applyClientAlert(projection, event);
        break;
      case 'period.opened':
        this.applyPeriodOpened(projection, event);
        break;
      case 'period.closed':
        this.applyPeriodClosed(projection, event);
        break;
      case 'rectification.filed':
        this.applyRectificationFiled(projection, event);
        break;
      case 'certificate.stored':
        this.applyCertificateStored(projection, event);
        break;
      case 'certificate.used':
        this.applyCertificateUsed(projection, event);
        break;
      case 'certificate.removed':
        projection.certificate = null;
        break;

      case 'output.rejected':
        projection.stats.rejected_count += 1;
        break;

      // ------------------------------------------------ ingestion (Onda 4)
      case 'doc.received':
        projection.stats.documents_received += 1;
        break;
      case 'doc.cancelled':
        projection.stats.documents_cancelled = (projection.stats.documents_cancelled ?? 0) + 1;
        break;

      // -------------------------------------------------- catalog (Onda 5)
      case 'item.classified':
      case 'item.reclassified':
        this.applyItemClassified(projection, event);
        break;

      // ---------------------------------------------- assessment (Onda 6)
      case 'assessment.projected':
        this.setPeriodState(projection, event, 'assessed');
        break;
      case 'assessment.adjusted':
        this.setPeriodState(projection, event, 'assessed');
        break;
      case 'assessment.compared':
        this.setPeriodState(projection, event, 'reconciled');
        break;
      case 'assessment.confirmed':
        this.applyAssessmentConfirmed(projection, event);
        break;

      /**
       * Sem efeito na projeção do CNPJ por enquanto. Cada uma ganha handler na
       * onda que a introduz; ficam explícitas para que a ausência de efeito seja
       * uma decisão visível e não um handler esquecido — num log fiscal, ignorar
       * um evento em silêncio produz apuração que omite documento.
       */
      case 'doc.manifested':
      case 'sped.imported':
      case 'bank.statement.imported':
      case 'rule.published':
      case 'fator_r.projected':
      case 'credit.recognized':
      case 'credit.conditioned':
      case 'credit.released':
      case 'credit.at_risk':
      case 'credit.lost':
      case 'deadline.approaching':
      case 'book.generated':
      // Propostas de agente: registradas como trilha, sem efetivar estado.
      case 'item.classify':
      case 'issue.report':
      case 'assessment.review':
      case 'credit.flag':
        break;

      default:
        throw new ProjectionError(event.action as never, event.event_seq);
    }
  }

  private applyClientEnrolled(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as ClientEnrolledPayload;

    projection.client = {
      legal_name: payload.legal_name,
      regime: payload.regime,
      status: 'active',
      enrolled_at: event.ts,
      enrolled_by: event.actor,
      ...optional('trade_name', payload.trade_name),
      ...optional('uf', payload.uf),
      ...optional('municipality_ibge', payload.municipality_ibge),
      ...optional('cnae_primary', payload.cnae_primary),
    };
  }

  private applyClientUpdated(projection: FiscalProjection, event: ESAAEventData): void {
    if (!projection.client) {
      return;
    }
    const payload = event.payload as unknown as ClientUpdatedPayload;

    projection.client = {
      ...projection.client,
      ...optional('trade_name', payload.trade_name),
      ...optional('regime', payload.regime),
      ...optional('regime_effective_from', payload.regime_effective_from),
      ...optional('status', payload.status),
    };
  }

  private applyClientAlert(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as ClientAlertPayload;

    projection.alerts.push({
      alert_id: payload.alert_id,
      kind: payload.kind,
      severity: payload.severity,
      message: payload.message,
      raised_at: event.ts,
    });
  }

  private applyPeriodOpened(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as PeriodOpenedPayload;

    projection.periods[payload.period] = {
      period: payload.period,
      state: 'open',
      opened_at: event.ts,
      ...optional('rectifies', payload.rectifies),
    };
  }

  private applyPeriodClosed(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as PeriodClosedPayload;
    const period = projection.periods[payload.period];
    if (!period) {
      return;
    }

    period.closed_at = event.ts;
    period.projection_hash = payload.projection_hash;
  }

  /**
   * A competência original **não** volta para `open`: recebe o ponteiro para a
   * retificação e permanece confirmada, com o hash original intacto. É o que
   * permite ao escritório mostrar o que entregou na época e o que corrigiu
   * depois, sem reescrever a história (INV-001).
   */
  private applyRectificationFiled(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as RectificationFiledPayload;

    const original = projection.periods[payload.original_period];
    if (original) {
      original.rectified_by = payload.rectification_period;
    }
  }

  private applyCertificateStored(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as CertificateStoredPayload;

    projection.certificate = {
      subject: payload.subject,
      issuer: payload.issuer,
      serial: payload.serial,
      valid_from: payload.valid_from,
      valid_to: payload.valid_to,
      stored_at: event.ts,
      stored_by: event.actor,
      usage_count: 0,
    };
  }

  private applyCertificateUsed(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as CertificateUsedPayload;
    projection.stats.certificate_uses += 1;

    if (!projection.certificate) {
      return;
    }

    projection.certificate.usage_count += 1;
    // Só uso bem-sucedido move o "último uso": uma falha de autenticação não é
    // evidência de que o certificado funcionou.
    if (payload.outcome === 'success') {
      projection.certificate.last_used_at = event.ts;
    }
  }

  /**
   * Reclassificar **substitui** a saúde do item, não acumula. Os totais saem
   * do mapa em `recalculateStats`, então uma reclassificação de `error` para
   * `ok` reduz o contador de erros — que é por onde o escritório prioriza.
   *
   * `items_classified` conta eventos, não itens: é quantas vezes houve
   * classificação, incluindo reclassificações.
   */
  private applyItemClassified(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as ItemClassifiedPayload;

    projection.catalog.items[payload.item_id] = payload.health;
    projection.stats.items_classified += 1;
  }

  private applyAssessmentConfirmed(projection: FiscalProjection, event: ESAAEventData): void {
    const payload = event.payload as unknown as AssessmentConfirmedPayload;
    const period = projection.periods[payload.period];
    if (!period) {
      return;
    }

    period.state = 'confirmed';
    period.confirmed_at = event.ts;
    period.confirmed_by = event.actor;
    period.projection_hash = payload.projection_hash;
  }

  /**
   * Transições de estado de competência vindas de `assessment.*`. A validação de
   * legalidade da transição é da camada 4; aqui a projeção confia que ela passou,
   * e por isso não revalida — revalidar mascararia um furo no pipeline.
   */
  private setPeriodState(
    projection: FiscalProjection,
    event: ESAAEventData,
    state: PeriodState,
  ): void {
    const periodId = event.period ?? (event.payload as { period?: string }).period;
    if (!periodId) {
      return;
    }

    const period = projection.periods[periodId];
    if (period) {
      period.state = state;
    }
  }

  private recalculateStats(projection: FiscalProjection): void {
    const periods = Object.values(projection.periods);

    projection.stats.periods_total = periods.length;
    projection.stats.periods_open = periods.filter((p) => p.state === 'open').length;
    projection.stats.periods_assessed = periods.filter((p) => p.state === 'assessed').length;
    projection.stats.periods_reconciled = periods.filter((p) => p.state === 'reconciled').length;
    projection.stats.periods_confirmed = periods.filter((p) => p.state === 'confirmed').length;
    projection.stats.open_issues = projection.issues.filter((i) => i.status === 'open').length;

    const saudes = Object.values(projection.catalog.items);
    projection.catalog.items_total = saudes.length;
    projection.catalog.ok = saudes.filter((s) => s === 'ok').length;
    projection.catalog.warning = saudes.filter((s) => s === 'warning').length;
    projection.catalog.error = saudes.filter((s) => s === 'error').length;
  }
}

function emptyCatalog(): CatalogProjection {
  return { items: {}, items_total: 0, ok: 0, warning: 0, error: 0 };
}

function emptyStats(): FiscalProjection['stats'] {
  return {
    periods_total: 0,
    periods_open: 0,
    periods_assessed: 0,
    periods_reconciled: 0,
    periods_confirmed: 0,
    documents_received: 0,
    items_classified: 0,
    credits_by_state: Object.fromEntries(
      CREDIT_STATES.map((state) => [state, 0]),
    ) as FiscalProjection['stats']['credits_by_state'],
    open_issues: 0,
    rejected_count: 0,
    certificate_uses: 0,
  };
}

/**
 * Inclui a chave só quando há valor. `undefined` explícito quebraria
 * `exactOptionalPropertyTypes` se ele for ligado, e um `null` no lugar mudaria o
 * hash da projeção sem mudar o significado.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
