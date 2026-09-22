import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import {
  emptyCodeTables,
  validateClassification,
  type Classification,
  type CodeTables,
  type Health,
  type NcmFlags,
  type ValidationOutcome,
} from './code-validation.js';

export interface ItemResumo {
  item_id: string;
  description: string | null;
  ncm: string | null;
  nbs: string | null;
  health: Health;
  health_reasons: string[];
  effective_from: string | null;
  documents_affected: number;
  last_seen_at: string | null;
}

export interface CatalogHealth {
  items_total: number;
  ok: number;
  warning: number;
  error: number;
  /** Notas **emitidas** contaminadas por item com problema. É o diferencial. */
  outbound_documents_affected: number;
  inbound_documents_affected: number;
  amount_at_stake_cents: number;
  top_reasons: { reason: string; count: number }[];
  /**
   * Quantos itens não puderam ser verificados por falta das tabelas oficiais.
   * Fica em campo próprio para não se confundir com "está tudo certo".
   */
  not_verified: number;
  reference_tables_loaded: boolean;
}

/**
 * Catálogo de itens do cliente e saúde da classificação.
 *
 * A pergunta que este serviço responde e que um verificador de XML não responde:
 * *quantas notas já emitidas cada item mal classificado contaminou*. O erro
 * nasce no cadastro e se propaga; olhar documento por documento nunca chega lá.
 */
export class CatalogService {
  constructor(private readonly pool: Pool) {}

  /**
   * Carrega as tabelas oficiais. Tabela vazia é devolvida como vazia de
   * propósito: a validação reporta "não verificado", nunca "ok".
   */
  async loadCodeTables(): Promise<CodeTables> {
    const [codigos, pares, flags] = await Promise.all([
      this.pool.query<{ kind: string; code: string }>(
        `select kind, code from fiscal_codes
          where valid_to is null or valid_to >= current_date`,
      ),
      this.pool.query<{ cclasstrib: string; cst_ibs_cbs: string }>(
        'select cclasstrib, cst_ibs_cbs from cclasstrib_cst',
      ),
      this.pool.query<{ ncm: string; monophasic: boolean; tax_substitution: boolean }>(
        'select ncm, monophasic, tax_substitution from ncm_flags',
      ),
    ]);

    const porTipo = (kind: string): Set<string> =>
      new Set(codigos.rows.filter((r) => r.kind === kind).map((r) => r.code.trim()));

    const cclasstribCst = new Map<string, Set<string>>();
    for (const par of pares.rows) {
      const chave = par.cclasstrib.trim();
      const atual = cclasstribCst.get(chave) ?? new Set<string>();
      atual.add(par.cst_ibs_cbs.trim());
      cclasstribCst.set(chave, atual);
    }

    const ncmFlags = new Map<string, NcmFlags>(
      flags.rows.map((r) => [
        r.ncm.trim(),
        { monophasic: r.monophasic, taxSubstitution: r.tax_substitution },
      ]),
    );

    return { ...emptyCodeTables(), ...tiposConhecidos(porTipo), cclasstribCst, ncmFlags };
  }

  /** Valida uma classificação contra as tabelas carregadas. */
  async validate(classification: Classification): Promise<ValidationOutcome> {
    return validateClassification(classification, await this.loadCodeTables());
  }

  /**
   * Grava a classificação. Insere uma linha nova por vigência em vez de
   * atualizar: reclassificar não reescreve o passado, e é o que permite mostrar
   * qual classificação valia quando cada nota foi emitida.
   */
  async saveClassification(
    scope: EventScope,
    itemId: string,
    classification: Classification,
    outcome: ValidationOutcome,
    eventSeq: number,
    userId: string,
  ): Promise<void> {
    await this.pool.query(
      `insert into items (tenant_id, cnpj, item_id, description)
       values ($1::uuid, $2::char(14), $3, $4)
       on conflict (tenant_id, cnpj, item_id) do update
         set description = coalesce(excluded.description, items.description)`,
      [scope.tenantId, scope.cnpj, itemId, classification.justification ?? null],
    );

    await this.pool.query(
      `insert into item_classifications (
         tenant_id, cnpj, item_id, effective_from, ncm, nbs, cst_ibs_cbs, cclasstrib,
         cst_icms, cst_pis_cofins, cfop_default, justification,
         health, health_issues, event_seq, classified_by
       ) values ($1::uuid, $2::char(14), $3, $4::char(7), $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14::jsonb, $15, $16::uuid)
       on conflict (tenant_id, cnpj, item_id, effective_from) do update set
         ncm = excluded.ncm,
         nbs = excluded.nbs,
         cst_ibs_cbs = excluded.cst_ibs_cbs,
         cclasstrib = excluded.cclasstrib,
         cst_icms = excluded.cst_icms,
         cst_pis_cofins = excluded.cst_pis_cofins,
         cfop_default = excluded.cfop_default,
         justification = excluded.justification,
         health = excluded.health,
         health_issues = excluded.health_issues,
         event_seq = excluded.event_seq,
         classified_by = excluded.classified_by,
         classified_at = now()`,
      [
        scope.tenantId,
        scope.cnpj,
        itemId,
        classification.effectiveFrom,
        classification.ncm ?? null,
        classification.nbs ?? null,
        classification.cstIbsCbs ?? null,
        classification.cclasstrib ?? null,
        classification.cstIcms ?? null,
        classification.cstPisCofins ?? null,
        classification.cfopDefault ?? null,
        classification.justification ?? null,
        outcome.health,
        // A inconsistência inteira, não só a mensagem: as trilhas de auditoria
        // agrupam por `reason`, e casar por trecho de texto quebraria em
        // silêncio quando uma mensagem mudasse.
        JSON.stringify(outcome.issues),
        eventSeq,
        userId,
      ],
    );
  }

  /** Um item já foi classificado alguma vez? Distingue `classified` de `reclassified`. */
  async hasClassification(scope: EventScope, itemId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `select 1 from item_classifications
        where tenant_id = $1::uuid and cnpj = $2::char(14) and item_id = $3 limit 1`,
      [scope.tenantId, scope.cnpj, itemId],
    );
    return rows.length > 0;
  }

  async listItems(
    scope: EventScope,
    filtro: { health?: Health; page: number; pageSize: number },
  ): Promise<{ items: ItemResumo[]; total: number }> {
    const { rows } = await this.pool.query(
      `with vigente as (
         select distinct on (c.item_id) c.*
           from item_classifications c
          where c.tenant_id = $1::uuid and c.cnpj = $2::char(14)
          order by c.item_id, c.effective_from desc
       ),
       propagacao as (
         select item_id, outbound_documents_affected + inbound_documents_affected as documentos
           from item_propagation($1::uuid, $2::char(14))
       )
       select i.item_id, i.description, i.last_seen_at,
              v.ncm, v.nbs, v.health, v.health_issues, v.effective_from,
              coalesce(p.documentos, 0) as documents_affected,
              count(*) over () as total
         from items i
         left join vigente v on v.item_id = i.item_id
         left join propagacao p on p.item_id = i.item_id
        where i.tenant_id = $1::uuid and i.cnpj = $2::char(14)
          and ($3::text is null or v.health = $3::text)
        order by
          -- Pior saúde primeiro, e dentro dela o que contamina mais notas: é a
          -- ordem em que o escritório deve atacar a fila.
          case v.health when 'error' then 0 when 'warning' then 1 else 2 end,
          coalesce(p.documentos, 0) desc,
          i.item_id
        limit $4 offset $5`,
      [
        scope.tenantId,
        scope.cnpj,
        filtro.health ?? null,
        filtro.pageSize,
        (filtro.page - 1) * filtro.pageSize,
      ],
    );

    return {
      items: rows.map((row: Record<string, unknown>) => ({
        item_id: String(row['item_id']),
        description: (row['description'] as string | null) ?? null,
        ncm: trimOrNull(row['ncm']),
        nbs: trimOrNull(row['nbs']),
        health: (row['health'] as Health | null) ?? 'warning',
        // A lista mostra mensagens; a estrutura fica no banco para as trilhas.
        health_reasons: (row['health_issues'] as { message: string }[] | null)?.map(
          (i) => i.message,
        ) ?? ['Item nunca classificado.'],
        effective_from: trimOrNull(row['effective_from']),
        documents_affected: Number(row['documents_affected']),
        last_seen_at: row['last_seen_at'] ? String(row['last_seen_at']) : null,
      })),
      total: Number(rows[0]?.['total'] ?? 0),
    };
  }

  /**
   * Saúde do cadastro com propagação para as notas.
   *
   * `outbound_documents_affected` é o número que vende: são notas **já emitidas**
   * com item mal classificado. O escritório não descobre isso olhando XML por
   * XML, porque a pergunta é sobre o cadastro.
   */
  async health(scope: EventScope): Promise<CatalogHealth> {
    const [resumo, propagacao, motivos, referencia] = await Promise.all([
      this.pool.query<{ total: string; ok: string; warning: string; error: string; nunca: string }>(
        `with vigente as (
           select distinct on (c.item_id) c.item_id, c.health
             from item_classifications c
            where c.tenant_id = $1::uuid and c.cnpj = $2::char(14)
            order by c.item_id, c.effective_from desc
         )
         select count(*)::text as total,
                count(*) filter (where v.health = 'ok')::text      as ok,
                count(*) filter (where v.health = 'warning')::text as warning,
                count(*) filter (where v.health = 'error')::text   as error,
                count(*) filter (where v.health is null)::text     as nunca
           from items i
           left join vigente v on v.item_id = i.item_id
          where i.tenant_id = $1::uuid and i.cnpj = $2::char(14)`,
        [scope.tenantId, scope.cnpj],
      ),
      this.pool.query<{ outbound: string; inbound: string; valor: string }>(
        `select coalesce(sum(outbound_documents_affected), 0)::text as outbound,
                coalesce(sum(inbound_documents_affected), 0)::text  as inbound,
                coalesce(sum(total_cents_affected), 0)::text        as valor
           from item_propagation($1::uuid, $2::char(14))
          -- "is distinct from" e nao "<>": item nunca classificado vem com
          -- health nulo, e null <> 'ok' e nulo, nao verdadeiro — filtraria fora
          -- justamente quem representa o trabalho que falta.
          where health is distinct from 'ok'`,
        [scope.tenantId, scope.cnpj],
      ),
      this.pool.query<{ reason: string; total: string }>(
        `with vigente as (
           select distinct on (c.item_id) c.item_id, c.health_issues
             from item_classifications c
            where c.tenant_id = $1::uuid and c.cnpj = $2::char(14)
            order by c.item_id, c.effective_from desc
         )
         select issue->>'message' as reason, count(*)::text as total
           from vigente, jsonb_array_elements(vigente.health_issues) as issue
          group by issue->>'message'
          order by count(*) desc
          limit 5`,
        [scope.tenantId, scope.cnpj],
      ),
      this.pool.query<{ codigos: string; pares: string }>(
        `select (select count(*)::text from fiscal_codes)   as codigos,
                (select count(*)::text from cclasstrib_cst) as pares`,
      ),
    ]);

    const r = resumo.rows[0]!;
    const p = propagacao.rows[0]!;
    const ref = referencia.rows[0]!;

    const tabelasCarregadas = Number(ref.codigos) > 0 && Number(ref.pares) > 0;
    const naoVerificados = motivos.rows
      .filter((m) => m.reason.includes('não verificado') || m.reason.includes('não verificada'))
      .reduce((total, m) => total + Number(m.total), 0);

    return {
      // Item nunca classificado conta como warning: não é "ok", e omiti-lo
      // esconderia justamente o trabalho que falta.
      items_total: Number(r.total),
      ok: Number(r.ok),
      warning: Number(r.warning) + Number(r.nunca),
      error: Number(r.error),
      outbound_documents_affected: Number(p.outbound),
      inbound_documents_affected: Number(p.inbound),
      amount_at_stake_cents: Number(p.valor),
      top_reasons: motivos.rows.map((m) => ({ reason: m.reason, count: Number(m.total) })),
      not_verified: naoVerificados,
      reference_tables_loaded: tabelasCarregadas,
    };
  }

  /** Registra que o item apareceu num documento, para priorizar o que está em uso. */
  async touchItems(scope: EventScope, itens: readonly { code: string }[]): Promise<void> {
    for (const item of itens) {
      if (item.code.length === 0) {
        continue;
      }
      await this.pool.query(
        `insert into items (tenant_id, cnpj, item_id, last_seen_at)
         values ($1::uuid, $2::char(14), $3, now())
         on conflict (tenant_id, cnpj, item_id) do update set last_seen_at = now()`,
        [scope.tenantId, scope.cnpj, item.code],
      );
    }
  }
}

function tiposConhecidos(porTipo: (kind: string) => Set<string>): Partial<CodeTables> {
  return {
    ncm: porTipo('ncm'),
    nbs: porTipo('nbs'),
    cfop: porTipo('cfop'),
    cstIcms: porTipo('cst_icms'),
    cstPisCofins: porTipo('cst_pis_cofins'),
    cstIbsCbs: porTipo('cst_ibs_cbs'),
  };
}

function trimOrNull(valor: unknown): string | null {
  return typeof valor === 'string' ? valor.trim() : null;
}
