import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import {
  parseStatement,
  type RejectedStatementLine,
  type StatementLine,
} from './statement-parser.js';
import {
  matchPayments,
  type MatchConfidence,
  type PayableDocument,
  type PaymentMatch,
} from './payment-matching.js';
import {
  aggregateBySupplier,
  classifyCredits,
  type CreditInput,
  type CreditPosition,
  type SupplierRisk,
} from './credit-risk.js';

export interface ImportOutcome {
  statement_id: string;
  source: 'ofx' | 'csv';
  reference: string;
  account: string | null;
  period_from: string | null;
  period_to: string | null
  lines_imported: number;
  lines_duplicated: number;
  rejected: RejectedStatementLine[];
  matches: PaymentMatch[];
  ambiguous: number;
  event_seq: number;
  projection_hash: string;
}

export interface CreditRiskReport {
  period: string | null;
  /**
   * `false` quando nenhum extrato foi importado.
   *
   * Sem extrato, todo crédito da reforma aparece como condicionado por falta de
   * pagamento identificado — o que é indistinguível de "o cliente não pagou
   * ninguém". A tela precisa da diferença.
   */
  statements_imported: boolean;
  suppliers: SupplierRisk[];
  positions: CreditPosition[];
  totals: {
    expectedCents: number;
    conditionedCents: number;
    releasedCents: number;
    atRiskCents: number;
  };
}

export class StatementNotUsableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementNotUsableError';
  }
}

/**
 * Crédito em risco por fornecedor — diferencial #7.
 *
 * O crédito de IBS/CBS é condicionado à extinção do tributo da etapa anterior, e
 * sob split payment a extinção acontece na liquidação financeira: é por isso que
 * o extrato bancário é informação fiscal, e é o vão que o briefing aponta
 * ("players fiscais não olham o banco").
 *
 * O estado do crédito **não é gravado**: é derivado na leitura. Gravá-lo
 * congelaria o estado na data do cálculo, e é justamente o crédito condicionado
 * que envelhece sem pagamento que esta onda existe para mostrar.
 */
export class CreditService {
  constructor(private readonly pool: Pool) {}

  async importStatement(
    scope: EventScope,
    input: { content: string; reference: string },
    orchestrator: FiscalOrchestratorService,
    actor: string,
    importedBy: string | null,
  ): Promise<ImportOutcome> {
    const extrato = parseStatement(input.content);

    if (extrato.lines.length === 0) {
      throw new StatementNotUsableError(
        'Nenhum lançamento aproveitável no extrato. ' +
          (extrato.rejected.length > 0
            ? `${extrato.rejected.length} linha(s) recusada(s): ${extrato.rejected[0]!.reason}`
            : 'O arquivo não trouxe lançamento nenhum.'),
      );
    }

    const outcome = await orchestrator.processIntention({
      action: 'bank.statement.imported',
      task_id: `extrato:${input.reference}`,
      actor,
      payload: {
        source: extrato.source,
        reference: input.reference,
        account: extrato.account ?? null,
        period_from: extrato.periodFrom ?? null,
        period_to: extrato.periodTo ?? null,
        lines: extrato.lines.length,
        rejected: extrato.rejected.length,
      },
    });

    if (!outcome.accepted) {
      throw new StatementNotUsableError(
        outcome.rejectionReason ?? 'Importação do extrato rejeitada pelo pipeline.',
      );
    }

    const eventSeq = outcome.event!.event_seq;
    const { statementId, importadas, duplicadas } = await this.persistStatement(
      scope,
      extrato,
      input.reference,
      eventSeq,
      importedBy,
    );

    const matches = await this.rematch(scope);

    return {
      statement_id: statementId,
      source: extrato.source,
      reference: input.reference,
      account: extrato.account ?? null,
      period_from: extrato.periodFrom ?? null,
      period_to: extrato.periodTo ?? null,
      lines_imported: importadas,
      lines_duplicated: duplicadas,
      rejected: extrato.rejected,
      matches,
      ambiguous: matches.filter((m) => m.confidence === 'ambiguous').length,
      event_seq: eventSeq,
      projection_hash: outcome.projection!.projection_hash_sha256,
    };
  }

  /**
   * Refaz o casamento sobre todo o extrato e todos os documentos de entrada.
   *
   * Refeito por inteiro, e não incremental: um lançamento novo pode desfazer
   * uma ambiguidade anterior, e um casamento incremental manteria a hipótese
   * velha ao lado da nova.
   */
  async rematch(scope: EventScope): Promise<PaymentMatch[]> {
    const [documentos, lancamentos] = await Promise.all([
      this.loadPayables(scope),
      this.loadStatementLines(scope),
    ]);

    const matches = matchPayments({ documents: documentos, lines: lancamentos });
    await this.persistMatches(scope, matches, lancamentos);

    return matches;
  }

  async riskReport(scope: EventScope, period?: string): Promise<CreditRiskReport> {
    const [entradas, temExtrato] = await Promise.all([
      this.loadCreditInputs(scope, period),
      this.hasStatements(scope),
    ]);

    const posicoes = classifyCredits(entradas, new Date());
    const fornecedores = aggregateBySupplier(posicoes);

    const somaDe = (estado: CreditPosition['state']): number =>
      posicoes.filter((p) => p.state === estado).reduce((s, p) => s + p.amountCents, 0);

    return {
      period: period ?? null,
      statements_imported: temExtrato,
      suppliers: fornecedores,
      positions: posicoes,
      totals: {
        expectedCents: somaDe('expected'),
        conditionedCents: somaDe('conditioned'),
        releasedCents: somaDe('released'),
        atRiskCents: somaDe('at_risk'),
      },
    };
  }

  // ----------------------------------------------------------- persistência

  private async persistStatement(
    scope: EventScope,
    extrato: { source: 'ofx' | 'csv'; account?: string; periodFrom?: string; periodTo?: string; lines: readonly StatementLine[] },
    reference: string,
    eventSeq: number,
    importedBy: string | null,
  ): Promise<{ statementId: string; importadas: number; duplicadas: number }> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      const { rows } = await client.query<{ id: string }>(
        `insert into bank_statements (
           tenant_id, cnpj, source, reference, account, period_from, period_to,
           lines_count, event_seq, imported_by
         ) values ($1::uuid, $2::char(14), $3::statement_source, $4, $5,
                   $6::date, $7::date, $8, $9, $10::uuid)
         returning id`,
        [
          scope.tenantId,
          scope.cnpj,
          extrato.source,
          reference,
          extrato.account ?? null,
          extrato.periodFrom ?? null,
          extrato.periodTo ?? null,
          extrato.lines.length,
          eventSeq,
          importedBy,
        ],
      );

      const statementId = rows[0]!.id;
      let importadas = 0;

      for (const linha of extrato.lines) {
        /**
         * `on conflict do nothing` no `fitid`: o mesmo extrato enviado duas
         * vezes não pode dobrar o pagamento, senão o crédito apareceria com
         * liquidação que aconteceu uma vez só. O resultado diz quantas linhas
         * eram repetidas, para o usuário não achar que o arquivo não entrou.
         */
        const { rowCount } = await client.query(
          `insert into bank_statement_lines (
             tenant_id, cnpj, statement_id, fitid, posted_at, amount_cents,
             description, counterparty_doc
           ) values ($1::uuid, $2::char(14), $3::uuid, $4, $5::date, $6, $7, $8::char(14))
           on conflict (tenant_id, cnpj, fitid) do nothing`,
          [
            scope.tenantId,
            scope.cnpj,
            statementId,
            linha.fitid,
            linha.postedAt,
            linha.amountCents,
            linha.description,
            linha.counterpartyDoc ?? null,
          ],
        );

        importadas += rowCount ?? 0;
      }

      await client.query('commit');

      return {
        statementId,
        importadas,
        duplicadas: extrato.lines.length - importadas,
      };
    } catch (causa) {
      await client.query('rollback');
      throw causa;
    } finally {
      client.release();
    }
  }

  private async persistMatches(
    scope: EventScope,
    matches: readonly PaymentMatch[],
    lancamentos: readonly (StatementLine & { id: number })[],
  ): Promise<void> {
    const porFitid = new Map(lancamentos.map((l) => [l.fitid, l.id]));
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      await client.query(
        'delete from payment_matches where tenant_id = $1::uuid and cnpj = $2::char(14)',
        [scope.tenantId, scope.cnpj],
      );

      for (const match of matches) {
        const lineId = porFitid.get(match.fitid);
        if (lineId === undefined) {
          continue;
        }

        await client.query(
          `insert into payment_matches (tenant_id, cnpj, access_key, line_id, confidence, rationale)
           values ($1::uuid, $2::char(14), $3::char(44), $4, $5::match_confidence, $6)
           on conflict (tenant_id, cnpj, access_key, line_id) do update set
             confidence = excluded.confidence,
             rationale = excluded.rationale,
             matched_at = now()`,
          [scope.tenantId, scope.cnpj, match.accessKey, lineId, match.confidence, match.rationale],
        );
      }

      await client.query('commit');
    } catch (causa) {
      await client.query('rollback');
      throw causa;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- leitura

  private async loadPayables(scope: EventScope): Promise<PayableDocument[]> {
    const { rows } = await this.pool.query<{
      access_key: string;
      number: string | null;
      issuer_cnpj: string;
      issuer_name: string | null;
      issued_at: string;
      total_cents: string;
    }>(
      `select access_key, number, issuer_cnpj, issuer_name, issued_at, total_cents
         from documents
        where tenant_id = $1::uuid and cnpj = $2::char(14) and direction = 'inbound'
        order by issued_at`,
      [scope.tenantId, scope.cnpj],
    );

    return rows.map((r) => ({
      accessKey: String(r.access_key).trim(),
      number: r.number,
      supplierCnpj: String(r.issuer_cnpj).trim(),
      supplierName: r.issuer_name,
      issuedAt: new Date(r.issued_at).toISOString(),
      totalCents: Number(r.total_cents),
    }));
  }

  private async loadStatementLines(
    scope: EventScope,
  ): Promise<(StatementLine & { id: number })[]> {
    const { rows } = await this.pool.query<{
      id: string;
      fitid: string | null;
      posted_at: string;
      amount_cents: string;
      description: string;
      counterparty_doc: string | null;
    }>(
      `select id, fitid, posted_at, amount_cents, description, counterparty_doc
         from bank_statement_lines
        where tenant_id = $1::uuid and cnpj = $2::char(14)
        order by posted_at, id`,
      [scope.tenantId, scope.cnpj],
    );

    return rows.map((r) => ({
      id: Number(r.id),
      fitid: r.fitid ?? String(r.id),
      postedAt: new Date(r.posted_at).toISOString().slice(0, 10),
      amountCents: Number(r.amount_cents),
      description: r.description,
      ...(r.counterparty_doc === null
        ? {}
        : { counterpartyDoc: String(r.counterparty_doc).trim() }),
    }));
  }

  /**
   * Um crédito por documento de entrada e por tributo destacado.
   *
   * O casamento entra pelo `left join`: documento sem pagamento identificado tem
   * de aparecer, porque é ele que vira crédito condicionado e depois em risco.
   * Um `inner join` mostraria só o que já foi pago — o oposto do que o
   * escritório precisa ver.
   */
  private async loadCreditInputs(scope: EventScope, period?: string): Promise<CreditInput[]> {
    const { rows } = await this.pool.query<{
      access_key: string;
      period: string;
      issuer_cnpj: string;
      issuer_name: string | null;
      issued_at: string;
      has_reform_group: boolean;
      legacy_taxes: Record<string, { amountCents?: number }> | null;
      reform_taxes: Record<string, { amountCents?: number }> | null;
      confidence: MatchConfidence | null;
      posted_at: string | null;
    }>(
      `select d.access_key, d.period, d.issuer_cnpj, d.issuer_name, d.issued_at,
              d.has_reform_group, i.legacy_taxes, i.reform_taxes,
              m.confidence, l.posted_at
         from documents d
         join document_items i
           on i.tenant_id = d.tenant_id and i.cnpj = d.cnpj and i.access_key = d.access_key
         left join payment_matches m
           on m.tenant_id = d.tenant_id and m.cnpj = d.cnpj and m.access_key = d.access_key
         left join bank_statement_lines l on l.id = m.line_id
        where d.tenant_id = $1::uuid and d.cnpj = $2::char(14)
          and d.direction = 'inbound'
          and ($3::char(7) is null or d.period = $3::char(7))
        order by d.issued_at, d.access_key, i.line`,
      [scope.tenantId, scope.cnpj, period ?? null],
    );

    const porChaveETributo = new Map<string, CreditInput>();

    for (const linha of rows) {
      const chave = String(linha.access_key).trim();

      for (const [tributo, valor] of tributosDaLinha(linha)) {
        if (valor === 0) {
          continue;
        }

        const id = `${chave}#${tributo}`;
        const existente = porChaveETributo.get(id);

        if (existente !== undefined) {
          // Um crédito por documento e tributo: os itens somam.
          existente.amountCents += valor;
          continue;
        }

        porChaveETributo.set(id, {
          accessKey: chave,
          period: String(linha.period).trim(),
          tax: tributo,
          supplierCnpj: String(linha.issuer_cnpj).trim(),
          supplierName: linha.issuer_name,
          amountCents: valor,
          issuedAt: new Date(linha.issued_at).toISOString(),
          hasReformGroup: linha.has_reform_group,
          ...(linha.confidence === null || linha.posted_at === null
            ? {}
            : {
                payment: {
                  confidence: linha.confidence,
                  postedAt: new Date(linha.posted_at).toISOString().slice(0, 10),
                },
              }),
        });
      }
    }

    return [...porChaveETributo.values()];
  }

  private async hasStatements(scope: EventScope): Promise<boolean> {
    const { rows } = await this.pool.query<{ total: string }>(
      `select count(*)::text as total from bank_statements
        where tenant_id = $1::uuid and cnpj = $2::char(14)`,
      [scope.tenantId, scope.cnpj],
    );

    return Number(rows[0]!.total) > 0;
  }
}

const LEGACY = ['icms', 'ipi', 'pis', 'cofins'] as const;

/**
 * O parser de NF-e grava `ibsUf`/`ibsMun` no jsonb; o motor e as tabelas usam
 * `ibs_uf`/`ibs_mun`. O mapa é o mesmo que a apuração dual já faz — sem ele, o
 * crédito de IBS-UF simplesmente não aparecia, e o total ficava menor sem erro
 * nenhum em log.
 */
const REFORM: readonly [string, string][] = [
  ['ibsUf', 'ibs_uf'],
  ['ibsMun', 'ibs_mun'],
  ['cbs', 'cbs'],
];

/** Pares (tributo, valor em centavos) de uma linha de item. */
function tributosDaLinha(linha: {
  legacy_taxes: Record<string, { amountCents?: number }> | null;
  reform_taxes: Record<string, { amountCents?: number }> | null;
}): [string, number][] {
  const saida: [string, number][] = [];

  for (const tributo of LEGACY) {
    saida.push([tributo, Number(linha.legacy_taxes?.[tributo]?.amountCents ?? 0)]);
  }

  for (const [noJson, noMotor] of REFORM) {
    saida.push([noMotor, Number(linha.reform_taxes?.[noJson]?.amountCents ?? 0)]);
  }

  return saida;
}
