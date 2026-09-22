import type { Pool, PoolClient } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { Regime } from '../shared/fiscal-vocabulary.js';
import {
  project,
  totalDue,
  type AnyTax,
  type AssessmentDocument,
  type AssessmentItem,
  type AssessmentResult,
  type CreditRule,
  type RuleSet,
} from './dual-assessment.js';

export interface StoredAssessment {
  period: string;
  regime: Regime;
  totals: AssessmentResult['legacy'] & AssessmentResult['reform'];
  not_computable: AssessmentResult['notComputable'];
  coverage: AssessmentResult['coverage'];
  documents_count: number;
  items_count: number;
  total_due_cents: number | null;
  projection_hash: string;
  event_seq: number;
  computed_at: string;
  adjustments: StoredAdjustment[];
}

export interface StoredAdjustment {
  id: string;
  tax: string;
  amount_cents: number;
  reason: string;
  reference_access_key: string | null;
  created_at: string;
}

/**
 * Apuração mensal de um CNPJ.
 *
 * Lê os documentos já ingeridos, resolve as regras vigentes na competência e
 * projeta os dois sistemas lado a lado. A memória de cálculo é persistida linha
 * por linha: é o que o contador apresenta para defender o número.
 */
/** Linhas por `INSERT`. Ver `inserirLinhasEmLote`. */
const LOTE_DE_LINHAS = 500;

export class AssessmentService {
  constructor(private readonly pool: Pool) {}

  /**
   * Regras vigentes no **primeiro dia da competência**, não na data de hoje.
   * Usar hoje faria uma apuração de janeiro ser recalculada com a regra que
   * entrou em março.
   */
  async loadRules(regime: Regime, period: string): Promise<RuleSet> {
    const { rows } = await this.pool.query<{
      kind: string;
      tax: string;
      value: string;
      rule_id: string;
    }>('select kind, tax, value, rule_id from effective_rules($1::regime, $2::date)', [
      regime,
      `${period}-01`,
    ]);

    const creditRules = new Map<AnyTax, CreditRule>();
    for (const linha of rows) {
      if (linha.kind !== 'credit_share') {
        continue;
      }
      creditRules.set(linha.tax as AnyTax, {
        tax: linha.tax as AnyTax,
        creditableShare: Number(linha.value),
        ruleId: linha.rule_id,
      });
    }

    return { creditRules };
  }

  /** Documentos da competência, com itens e os dois sistemas de tributos. */
  async loadDocuments(scope: EventScope, period: string): Promise<AssessmentDocument[]> {
    const { rows } = await this.pool.query<{
      access_key: string;
      direction: 'inbound' | 'outbound';
      line: number;
      code: string | null;
      ncm: string | null;
      total_cents: string;
      legacy_taxes: Record<string, unknown>;
      reform_taxes: Record<string, unknown> | null;
    }>(
      `select d.access_key, d.direction,
              di.line, di.code, di.ncm, di.total_cents,
              di.legacy_taxes, di.reform_taxes
         from documents d
         join document_items di
           on di.tenant_id = d.tenant_id and di.cnpj = d.cnpj and di.access_key = d.access_key
        where d.tenant_id = $1::uuid and d.cnpj = $2::char(14) and d.period = $3::char(7)
        order by d.access_key, di.line`,
      [scope.tenantId, scope.cnpj, period],
    );

    const porDocumento = new Map<string, AssessmentDocument>();

    for (const linha of rows) {
      const chave = linha.access_key.trim();
      const documento =
        porDocumento.get(chave) ?? { accessKey: chave, direction: linha.direction, items: [] };

      (documento.items as AssessmentItem[]).push({
        line: linha.line,
        code: linha.code?.trim() ?? '',
        ncm: linha.ncm?.trim() ?? '',
        totalCents: Number(linha.total_cents),
        legacy: normalizarTributos(linha.legacy_taxes),
        ...(linha.reform_taxes === null
          ? {}
          : { reform: normalizarReforma(linha.reform_taxes) }),
      });

      porDocumento.set(chave, documento);
    }

    return [...porDocumento.values()];
  }

  async computeFor(
    scope: EventScope,
    period: string,
    regime: Regime,
  ): Promise<AssessmentResult> {
    const [documents, rules] = await Promise.all([
      this.loadDocuments(scope, period),
      this.loadRules(regime, period),
    ]);

    return project({ period, regime, documents, rules });
  }

  /**
   * Persiste a apuração e a memória de cálculo.
   *
   * As linhas antigas são apagadas antes: reapurar substitui a memória, e
   * misturar linhas de duas execuções daria um total que não fecha com nenhuma
   * das duas. O event log é que guarda o histórico, não esta tabela.
   */
  /**
   * Grava a apuração e a memória de cálculo.
   *
   * **Transacional, e isso não é zelo abstrato.** A versão anterior usava o pool
   * direto: apagava as linhas antigas e inseria as novas uma a uma, sem
   * transação. Interrompida no meio — deploy, timeout, OOM — deixava
   * `assessments` dizendo 578 itens e `assessment_lines` com menos, e a memória
   * de cálculo saía incompleta **sem nada indicar que estava incompleta**.
   * Aconteceu de verdade, numa apuração real de 2.211 linhas.
   *
   * As linhas vão em lote. Eram 2.211 `INSERT` sequenciais, cada um uma ida ao
   * banco: sobre a rede entre o serviço e o Postgres gerenciado isso passava de
   * dois minutos, e a transação ficava aberta esse tempo todo segurando lock.
   */
  async save(
    scope: EventScope,
    result: AssessmentResult,
    projectionHash: string,
    eventSeq: number,
  ): Promise<void> {
    const totals = { ...result.legacy, ...result.reform };
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      await client.query(
        `insert into assessments (
           tenant_id, cnpj, period, regime, totals, not_computable, coverage,
           documents_count, items_count, projection_hash, event_seq, computed_at
         ) values ($1::uuid, $2::char(14), $3::char(7), $4::regime, $5::jsonb, $6::jsonb,
                   $7::jsonb, $8, $9, $10, $11, now())
         on conflict (tenant_id, cnpj, period) do update set
           regime = excluded.regime,
           totals = excluded.totals,
           not_computable = excluded.not_computable,
           coverage = excluded.coverage,
           documents_count = excluded.documents_count,
           items_count = excluded.items_count,
           projection_hash = excluded.projection_hash,
           event_seq = excluded.event_seq,
           computed_at = now()`,
        [
          scope.tenantId,
          scope.cnpj,
          result.period,
          result.regime,
          JSON.stringify(totals),
          JSON.stringify(result.notComputable),
          JSON.stringify(result.coverage),
          result.documentsConsidered,
          result.itemsConsidered,
          projectionHash,
          eventSeq,
        ],
      );

      await client.query(
        `delete from assessment_lines
          where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
        [scope.tenantId, scope.cnpj, result.period],
      );

      await inserirLinhasEmLote(client, scope, result);

      await client.query('commit');
    } catch (causa) {
      await client.query('rollback');
      throw causa;
    } finally {
      client.release();
    }
  }

  async find(scope: EventScope, period: string): Promise<StoredAssessment | null> {
    const { rows } = await this.pool.query<{
      period: string;
      regime: Regime;
      totals: StoredAssessment['totals'];
      not_computable: StoredAssessment['not_computable'];
      coverage: StoredAssessment['coverage'];
      documents_count: number;
      items_count: number;
      projection_hash: string;
      event_seq: string;
      computed_at: Date;
    }>(
      `select period, regime, totals, not_computable, coverage,
              documents_count, items_count, projection_hash, event_seq, computed_at
         from assessments
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, period],
    );

    const linha = rows[0];
    if (!linha) {
      return null;
    }

    const { rows: ajustes } = await this.pool.query<{
      id: string;
      tax: string;
      amount_cents: string;
      reason: string;
      reference_access_key: string | null;
      created_at: Date;
    }>(
      `select id, tax, amount_cents, reason, reference_access_key, created_at
         from assessment_adjustments
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
        order by created_at`,
      [scope.tenantId, scope.cnpj, period],
    );

    const totals = linha.totals;
    const indeterminavel = Object.values(totals).some((t) => t.dueCents === null);
    const somaDevida = indeterminavel
      ? null
      : Object.values(totals).reduce((soma, t) => soma + (t.dueCents ?? 0), 0);

    return {
      period: linha.period.trim(),
      regime: linha.regime,
      totals,
      not_computable: linha.not_computable,
      coverage: linha.coverage,
      documents_count: linha.documents_count,
      items_count: linha.items_count,
      total_due_cents: somaDevida,
      projection_hash: linha.projection_hash,
      event_seq: Number(linha.event_seq),
      computed_at: linha.computed_at.toISOString(),
      adjustments: ajustes.map((a) => ({
        id: a.id,
        tax: a.tax,
        amount_cents: Number(a.amount_cents),
        reason: a.reason,
        reference_access_key: a.reference_access_key?.trim() ?? null,
        created_at: a.created_at.toISOString(),
      })),
    };
  }

  async saveAdjustment(
    scope: EventScope,
    period: string,
    ajuste: { tax: string; amountCents: number; reason: string; referenceAccessKey?: string },
    eventSeq: number,
    userId: string,
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into assessment_adjustments (
         tenant_id, cnpj, period, tax, amount_cents, reason,
         reference_access_key, event_seq, created_by
       ) values ($1::uuid, $2::char(14), $3::char(7), $4, $5, $6, $7, $8, $9::uuid)
       returning id`,
      [
        scope.tenantId,
        scope.cnpj,
        period,
        ajuste.tax,
        ajuste.amountCents,
        ajuste.reason,
        ajuste.referenceAccessKey ?? null,
        eventSeq,
        userId,
      ],
    );

    return rows[0]!.id;
  }

  /** Linhas da memória de cálculo, para o drill-down e para o Book. */
  async trace(
    scope: EventScope,
    period: string,
    filtro: { tax?: string; accessKey?: string },
  ): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `select access_key, line, tax, item_code, ncm, direction, cst,
              base_cents, rate, amount_cents, origin
         from assessment_lines
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
          and ($4::text is null or tax = $4::text)
          and ($5::text is null or access_key = $5::char(44))
        order by access_key, line, tax`,
      [scope.tenantId, scope.cnpj, period, filtro.tax ?? null, filtro.accessKey ?? null],
    );

    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      access_key: String(r['access_key']).trim(),
      base_cents: Number(r['base_cents']),
      rate: Number(r['rate']),
      amount_cents: Number(r['amount_cents']),
    }));
  }

  totalDueOf(result: AssessmentResult): number | null {
    return totalDue(result);
  }
}

/** `legacy_taxes` do read model vem como jsonb; aqui volta ao tipo do motor. */
function normalizarTributos(bruto: Record<string, unknown>): AssessmentItem['legacy'] {
  const saida: AssessmentItem['legacy'] = {};

  for (const tributo of ['icms', 'ipi', 'pis', 'cofins'] as const) {
    const valor = bruto[tributo] as Record<string, unknown> | undefined;
    if (valor) {
      saida[tributo] = {
        ...(typeof valor['cst'] === 'string' ? { cst: valor['cst'] } : {}),
        baseCents: Number(valor['baseCents'] ?? 0),
        rate: Number(valor['rate'] ?? 0),
        amountCents: Number(valor['amountCents'] ?? 0),
      };
    }
  }

  return saida;
}

function normalizarReforma(
  bruto: Record<string, unknown>,
): NonNullable<AssessmentItem['reform']> {
  const saida: NonNullable<AssessmentItem['reform']> = {};

  if (typeof bruto['cst'] === 'string') saida.cst = bruto['cst'];
  if (typeof bruto['cclasstrib'] === 'string') saida.cclasstrib = bruto['cclasstrib'];

  // O parser de NF-e usa ibsUf/ibsMun; o motor e a tabela usam ibs_uf/ibs_mun.
  const mapa: [string, 'ibs_uf' | 'ibs_mun' | 'cbs'][] = [
    ['ibsUf', 'ibs_uf'],
    ['ibsMun', 'ibs_mun'],
    ['cbs', 'cbs'],
  ];

  for (const [origem, destino] of mapa) {
    const valor = bruto[origem] as Record<string, unknown> | undefined;
    if (valor) {
      saida[destino] = {
        baseCents: Number(valor['baseCents'] ?? 0),
        rate: Number(valor['rate'] ?? 0),
        amountCents: Number(valor['amountCents'] ?? 0),
      };
    }
  }

  return saida;
}

/**
 * Linhas da memória de cálculo em lotes de `LOTE_DE_LINHAS`.
 *
 * Um `INSERT` com N tuplas em vez de N `INSERT`. O tamanho do lote existe por
 * causa do limite de 65.535 parâmetros do protocolo do Postgres: com 14 colunas
 * por linha, 500 linhas são 7.000 parâmetros — folgado, e ainda assim reduz
 * 2.211 idas ao banco para cinco.
 */
async function inserirLinhasEmLote(
  client: PoolClient,
  scope: EventScope,
  result: AssessmentResult,
): Promise<void> {
  const COLUNAS = 14;

  for (let i = 0; i < result.trace.length; i += LOTE_DE_LINHAS) {
    const lote = result.trace.slice(i, i + LOTE_DE_LINHAS);
    const valores: unknown[] = [];
    const marcadores: string[] = [];

    for (const [j, linha] of lote.entries()) {
      const base = j * COLUNAS;
      marcadores.push(
        `($${base + 1}::uuid, $${base + 2}::char(14), $${base + 3}::char(7), ` +
          `$${base + 4}::char(44), $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, ` +
          `$${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`,
      );
      valores.push(
        scope.tenantId,
        scope.cnpj,
        result.period,
        linha.accessKey,
        linha.line,
        linha.tax,
        linha.itemCode,
        linha.ncm,
        linha.direction,
        linha.cst ?? null,
        linha.baseCents,
        linha.rate,
        linha.amountCents,
        linha.origin,
      );
    }

    await client.query(
      `insert into assessment_lines (
         tenant_id, cnpj, period, access_key, line, tax, item_code, ncm,
         direction, cst, base_cents, rate, amount_cents, origin
       ) values ${marcadores.join(', ')}
       on conflict (tenant_id, cnpj, period, access_key, line, tax) do nothing`,
      valores,
    );
  }
}
