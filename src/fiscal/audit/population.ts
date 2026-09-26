import type pg from 'pg';

import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { Classification, CodeTables, NcmFlags } from '../catalog/code-validation.js';
import type { ExaminableSubject, PopulationKind } from './audit-procedure.js';

/**
 * Materializa a população de uma trilha a partir do banco.
 *
 * A regra do módulo vale campo a campo: o que a origem não sabe vem `null`, e
 * é o `null` que faz a verificação sair `not_verified` em vez de `pass`. O
 * contrário — preencher com o valor "mais provável" — é exatamente o que faria
 * o relatório afirmar uma conferência que não aconteceu.
 */
export class PopulationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async load(
    scope: EventScope,
    period: string,
    kind: PopulationKind,
    tables: CodeTables,
  ): Promise<ExaminableSubject[]> {
    switch (kind) {
      case 'itens_do_catalogo':
        return this.itensDoCatalogo(scope, period, tables);
      case 'creditos_de_entrada':
        return this.creditosDeEntrada(scope, period, tables);
      default:
        /**
         * Nenhuma trilha declara hoje as populações de documentos puros. Devolver
         * créditos no lugar delas seria examinar outra coisa sob o nome pedido,
         * que é o defeito que esta separação corrige.
         */
        throw new Error(`População '${kind}' ainda não tem leitura implementada.`);
    }
  }

  /**
   * Créditos de entrada **apropriados** na competência.
   *
   * Com a EFD-Contribuições da competência importada, a população é o que ela
   * declara como entrada, e a competência de apropriação é a da escrituração.
   * É isso que dá sentido à verificação 2: o documento emitido em janeiro e
   * apropriado em março aparece na auditoria de março, que é onde o crédito foi
   * tomado e onde o estorno teria de acontecer.
   *
   * Sem EFD, a população cai para os documentos emitidos na competência e a
   * apropriação fica `null`. Antes ela era copiada da própria competência de
   * emissão, e a verificação 2 passava sempre — comparava a data com ela mesma.
   */
  async creditosDeEntrada(
    scope: EventScope,
    period: string,
    tables: CodeTables,
  ): Promise<ExaminableSubject[]> {
    const { rows } = await this.pool.query<{
      access_key: string;
      issuer_cnpj: string;
      counterparty_cnpj: string | null;
      issued_at: Date;
      document_period: string;
      appropriated_period: string | null;
      total_cents: string;
      cancelled_at: Date | null;
      cancel_protocol: string | null;
      cnae_primary: string | null;
      single_ncm: string | null;
    }>(
      `with efd as (
         select id from sped_files
          where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
       ),
       escriturados as (
         select distinct sd.access_key
           from sped_documents sd
          where sd.sped_file_id = (select id from efd)
            and sd.operation = 'inbound' and sd.access_key is not null
       )
       select d.access_key, d.issuer_cnpj, d.counterparty_cnpj, d.issued_at,
              d.period as document_period,
              case when exists (select 1 from efd) then $3::text end as appropriated_period,
              d.total_cents, d.cancelled_at, d.cancel_protocol,
              c.cnae_primary,
              ncm.single_ncm
         from documents d
         join clients c on c.tenant_id = d.tenant_id and c.cnpj = d.cnpj
         left join lateral (
           select case when count(distinct di.ncm) = 1 then min(di.ncm) end as single_ncm
             from document_items di
            where di.tenant_id = d.tenant_id and di.cnpj = d.cnpj
              and di.access_key = d.access_key and di.ncm is not null
         ) ncm on true
        where d.tenant_id = $1::uuid and d.cnpj = $2::char(14) and d.direction = 'inbound'
          and case when exists (select 1 from efd)
                   then d.access_key in (select access_key from escriturados)
                   else d.period = $3::char(7)
              end
        order by d.access_key`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r) => ({
      subject: r.access_key,
      subjectKind: 'creditos_de_entrada' as const,
      accessKey: r.access_key,
      issuerCnpj: r.issuer_cnpj,
      recipientCnpj: r.counterparty_cnpj ?? scope.cnpj,
      issuedAt: r.issued_at.toISOString().slice(0, 10),
      /**
       * A competência derivada na ingestão, a partir da data de emissão do
       * próprio XML. Recalcular aqui a partir do `timestamptz` cortaria a data
       * em UTC, e a nota emitida às 22h do último dia do mês mudaria de mês.
       */
      documentPeriod: r.document_period,
      authorizationProtocol: r.cancel_protocol,
      /**
       * O cancelamento é coletado pela distribuição da SEFAZ: `true` ou `false`.
       * A denegação é situação distinta e a coleta não a traz; `false`
       * afirmaria que o documento não foi denegado, que é o que não se sabe.
       */
      cancelled: r.cancelled_at !== null,
      denied: null,
      appropriatedPeriod: r.appropriated_period,
      /** Classificação é do item, não da nota; a trilha de item a examina. */
      classification: null,
      /** Só quando a nota tem um NCM só: com vários, atribuir um seria escolher. */
      ncmFlags: flagsDoNcm(r.single_ncm, tables),
      cnaePrimary: r.cnae_primary,
      /**
       * Declaração do contador sobre a destinação, que o cadastro ainda não
       * tem. Não existe tabela oficial que derive insumo × uso e consumo do NCM.
       */
      usageKind: null,
      creditState: 'conditioned' as const,
      amountCents: Number(r.total_cents),
    }));
  }

  /**
   * Itens do catálogo com movimento na competência, cada um com a
   * classificação vigente nela.
   *
   * Vigente é a mais recente com `effective_from` até a competência:
   * reclassificar em maio não reescreve o que valia em março. Item sem
   * classificação vem com `classification: null`, e a verificação 3 sai
   * `not_verified` — "nunca classificado" não é "classificado certo".
   */
  async itensDoCatalogo(
    scope: EventScope,
    period: string,
    tables: CodeTables,
  ): Promise<ExaminableSubject[]> {
    const { rows } = await this.pool.query<{
      item_id: string;
      amount_cents: string;
      effective_from: string | null;
      ncm: string | null;
      nbs: string | null;
      cst_ibs_cbs: string | null;
      cclasstrib: string | null;
      cst_icms: string | null;
      cst_pis_cofins: string | null;
      cfop_default: string | null;
      justification: string | null;
      cnae_primary: string | null;
    }>(
      `with movimento as (
         select di.code as item_id, sum(di.total_cents) as amount_cents
           from document_items di
           join documents d
             on d.tenant_id = di.tenant_id and d.cnpj = di.cnpj and d.access_key = di.access_key
          where di.tenant_id = $1::uuid and di.cnpj = $2::char(14)
            and d.period = $3::char(7) and di.code is not null
          group by di.code
       ),
       vigente as (
         select distinct on (ic.item_id) ic.*
           from item_classifications ic
          where ic.tenant_id = $1::uuid and ic.cnpj = $2::char(14)
            and ic.effective_from <= $3::char(7)
          order by ic.item_id, ic.effective_from desc
       )
       select m.item_id, m.amount_cents::text as amount_cents,
              v.effective_from, v.ncm, v.nbs, v.cst_ibs_cbs, v.cclasstrib,
              v.cst_icms, v.cst_pis_cofins, v.cfop_default, v.justification,
              c.cnae_primary
         from movimento m
         join items i on i.tenant_id = $1::uuid and i.cnpj = $2::char(14) and i.item_id = m.item_id
         join clients c on c.tenant_id = i.tenant_id and c.cnpj = i.cnpj
         left join vigente v on v.item_id = m.item_id
        order by m.item_id`,
      [scope.tenantId, scope.cnpj, period],
    );

    return rows.map((r) => {
      const classification = paraClassificacao(r);

      return {
        subject: r.item_id,
        subjectKind: 'itens_do_catalogo' as const,
        accessKey: null,
        issuerCnpj: null,
        recipientCnpj: null,
        issuedAt: null,
        documentPeriod: null,
        authorizationProtocol: null,
        cancelled: null,
        denied: null,
        appropriatedPeriod: null,
        classification,
        ncmFlags: flagsDoNcm(classification?.ncm ?? null, tables),
        cnaePrimary: r.cnae_primary,
        usageKind: null,
        /** Item não é crédito: o achado vale como alerta e não mexe em saldo. */
        creditState: null,
        amountCents: Number(r.amount_cents),
      };
    });
  }
}

function flagsDoNcm(ncm: string | null, tables: CodeTables): NcmFlags | null {
  if (ncm === null) {
    return null;
  }
  return tables.ncmFlags.get(ncm.trim()) ?? null;
}

/** Coluna nula some do objeto: `validateClassification` trata ausente, não `null`. */
function paraClassificacao(r: {
  effective_from: string | null;
  ncm: string | null;
  nbs: string | null;
  cst_ibs_cbs: string | null;
  cclasstrib: string | null;
  cst_icms: string | null;
  cst_pis_cofins: string | null;
  cfop_default: string | null;
  justification: string | null;
}): Classification | null {
  if (r.effective_from === null) {
    return null;
  }

  const c: Classification = { effectiveFrom: r.effective_from };
  const campos: [keyof Classification, string | null][] = [
    ['ncm', r.ncm],
    ['nbs', r.nbs],
    ['cstIbsCbs', r.cst_ibs_cbs],
    ['cclasstrib', r.cclasstrib],
    ['cstIcms', r.cst_icms],
    ['cstPisCofins', r.cst_pis_cofins],
    ['cfopDefault', r.cfop_default],
    ['justification', r.justification],
  ];
  for (const [campo, valor] of campos) {
    if (valor !== null) {
      c[campo] = valor.trim();
    }
  }
  return c;
}
