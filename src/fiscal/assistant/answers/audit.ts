import type { Pool } from 'pg';
import type { EventScope } from '../../../esaa/core/event-store/value-objects/event-scope.vo.js';
import {
  divergenceCitation,
  documentCitation,
  eventCitation,
  explanation,
  fact,
  itemCitation,
  lineCitation,
  periodCitation,
  type Answer,
  type Claim,
  type Evidence,
} from '../grounding.js';
import { ReconciliationService } from '../../reconciliation/reconciliation.service.js';
import { brl, naoRespondivel } from './support.js';

/**
 * Respostas sobre auditoria: divergências do Fisco, saúde do cadastro,
 * histórico de um documento e prazos.
 *
 * Mesma regra das demais: evidência registrada antes do texto, e nenhuma
 * afirmação factual sem citação.
 */

export async function divergencias(
  pool: Pool,
  scope: EventScope,
  period: string,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  const reconciliation = new ReconciliationService(pool);
  const comparacao = await reconciliation.find(scope, period);

  if (!comparacao) {
    return naoRespondivel(
      'divergencias_do_fisco',
      tier,
      `Nenhuma proposta do Fisco foi registrada para a competência ${period}. ` +
        'Sem ela não há com o que comparar a nossa apuração.',
      [
        {
          action: 'assessment.compared',
          method: 'POST',
          endpoint: `/v1/clients/${scope.cnpj}/fisco-assessments/${period}`,
          rationale: 'Enviar a proposta recebida do Fisco produz a comparação nota a nota.',
        },
      ],
    );
  }

  const doPeriodo = evidencia.add(periodCitation(period));
  const claims: Claim[] = [];

  const { summary } = comparacao;
  claims.push(
    fact(
      `${summary.divergencesCount} divergência(s) entre a nossa apuração e a proposta ` +
        `do Fisco: ${summary.bySeverity.critical} crítica(s) e ` +
        `${summary.bySeverity.high} alta(s).`,
      [doPeriodo],
    ),
  );

  // Três números que não se somam: cada um leva a uma ação diferente.
  claims.push(
    fact(
      `Exposição de ${brl(summary.exposureCents)} em débito que o Fisco aponta e não ` +
        `escrituramos; ${brl(summary.creditLossCents)} em crédito que ele reconhece e ` +
        `não aproveitamos; ${brl(summary.creditAtRiskCents)} em crédito nosso que ele ` +
        'não reconhece.',
      [doPeriodo],
    ),
  );

  if (!summary.lineLevel) {
    claims.push(
      explanation(
        'A proposta veio só com totais por tributo, então a comparação nota a nota ' +
          'não aconteceu. A ausência de divergência de item aqui não significa que ' +
          'as notas conferem.',
      ),
    );
  }

  for (const divergencia of comparacao.divergences.slice(0, 5)) {
    const citacao = evidencia.add(divergenceCitation(period, divergencia.subject));
    if (divergencia.accessKey !== null && divergencia.line !== null) {
      evidencia.add(lineCitation(divergencia.accessKey, divergencia.line, divergencia.tax));
    }

    claims.push(
      fact(
        `${divergencia.subject} (${divergencia.tax.toUpperCase()}): causa provável ` +
          `"${divergencia.probableCause}", diferença de ` +
          `${brl(divergencia.differenceCents)}.`,
        [citacao, doPeriodo],
      ),
    );
  }

  claims.push(
    explanation(
      'A causa provável é hipótese, não diagnóstico: o sistema compara duas listas ' +
        'de números, e a razão real pode ser erro nosso, erro do Fisco, documento ' +
        'cancelado ou nota ainda não processada por um dos lados.',
    ),
  );

  return {
    intent: 'divergencias_do_fisco',
    tier,
    confidence: summary.lineLevel ? 'high' : 'medium',
    answerable: true,
    claims,
    suggested: [
      {
        action: 'consulta',
        method: 'GET',
        endpoint: `/v1/clients/${scope.cnpj}/fisco-assessments/${period}`,
        rationale: 'A lista completa de divergências, com a causa provável de cada uma.',
      },
    ],
  };
  }

export async function saudeDoCadastro(
  pool: Pool,
  scope: EventScope,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  const { rows } = await pool.query<{
    item_id: string;
    health: string;
    documentos: string;
    valor: string;
    mensagem: string | null;
  }>(
    `with vigente as (
       select distinct on (c.item_id) c.item_id, c.health, c.health_issues
         from item_classifications c
        where c.tenant_id = $1::uuid and c.cnpj = $2::char(14)
        order by c.item_id, c.effective_from desc
     )
     select v.item_id, v.health,
            coalesce(p.outbound_documents_affected + p.inbound_documents_affected, 0)::text
              as documentos,
            coalesce(p.total_cents_affected, 0)::text as valor,
            (v.health_issues->0->>'message') as mensagem
       from vigente v
       left join item_propagation($1::uuid, $2::char(14)) p on p.item_id = v.item_id
      where v.health <> 'ok'
      order by coalesce(p.outbound_documents_affected, 0) desc, v.item_id
      limit 10`,
    [scope.tenantId, scope.cnpj],
  );

  if (rows.length === 0) {
    return naoRespondivel(
      'saude_do_cadastro',
      tier,
      'Nenhum item classificado deste CNPJ está com inconsistência. Se o cadastro ' +
        'ainda não foi classificado, não há o que reportar — o que não é o mesmo que ' +
        'estar correto.',
    );
  }

  const claims: Claim[] = rows.map((r) =>
    fact(
      `Item ${r.item_id} está "${r.health}" e aparece em ${r.documentos} documento(s), ` +
        `${brl(Number(r.valor))} em jogo. ${r.mensagem ?? 'Sem mensagem registrada.'}`,
      [evidencia.add(itemCitation(r.item_id))],
    ),
  );

  claims.push(
    explanation(
      'A contagem de documentos é a propagação: quantas notas já emitidas carregam a ' +
        'classificação do item. É o número que os verificadores gratuitos não mostram, ' +
        'porque olham um XML por vez.',
    ),
  );

  return {
    intent: 'saude_do_cadastro',
    tier,
    confidence: 'high',
    answerable: true,
    claims,
    suggested: [
      {
        action: 'consulta',
        method: 'GET',
        endpoint: `/v1/clients/${scope.cnpj}/items/health`,
        rationale: 'O resumo completo da saúde do cadastro, com a propagação por item.',
      },
    ],
  };
  }

export async function historico(
  pool: Pool,
  scope: EventScope,
  accessKey: string | undefined,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  if (accessKey === undefined) {
    return naoRespondivel(
      'historico_do_documento',
      tier,
      'Para contar o histórico de uma nota eu preciso da chave de acesso de 44 ' +
        'dígitos. Sem ela eu não sei de qual documento se trata.',
    );
  }

  const { rows } = await pool.query<{
    event_seq: string;
    action: string;
    actor: string;
    ts: string;
    payload: Record<string, unknown>;
  }>(
    `select event_seq, action, actor, ts, payload
       from events
      where tenant_id = $1::uuid and cnpj = $2::char(14) and task_id = $3
      order by event_seq`,
    [scope.tenantId, scope.cnpj, accessKey],
  );

  if (rows.length === 0) {
    return naoRespondivel(
      'historico_do_documento',
      tier,
      `Nenhum evento no log deste CNPJ menciona a chave ${accessKey}. O documento não ` +
        'foi ingerido, ou pertence a outro CNPJ.',
    );
  }

  evidencia.add(documentCitation(accessKey));

  const claims: Claim[] = rows.map((r) => {
    const citacao = evidencia.add(
      eventCitation(Number(r.event_seq), `${r.action} em ${r.ts}`),
    );
    const motivo = r.payload['reason'];

    return fact(
      `#${r.event_seq} — ${r.action} por ${r.actor}` +
        (typeof motivo === 'string' ? `, motivo "${motivo}"` : '') +
        '.',
      [citacao],
    );
  });

  claims.push(
    explanation(
      'Cada número acima é a posição do evento no log deste CNPJ. O `POST /verify` ' +
        'reprocessa o log inteiro e confere o hash, então qualquer afirmação daqui é ' +
        'reproduzível por replay.',
    ),
  );

  return {
    intent: 'historico_do_documento',
    tier,
    confidence: 'high',
    answerable: true,
    claims,
    suggested: [
      {
        action: 'consulta',
        method: 'GET',
        endpoint: `/v1/clients/${scope.cnpj}/events?task_id=${accessKey}`,
        rationale: 'Os eventos completos, com o payload de cada um.',
      },
    ],
  };
  }

export async function prazos(
  pool: Pool,
  scope: EventScope,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  const reconciliation = new ReconciliationService(pool);
  // `readCalendar`, não `calendar`: o assistente não materializa prazo nenhum.
  const calendario = await reconciliation.readCalendar(scope.tenantId, 30);

  const doCnpj = calendario.pendencies.filter((p) => p.cnpj === scope.cnpj);
  const prazosDoCnpj = calendario.deadlines.filter((d) => d.cnpj === scope.cnpj);

  if (doCnpj.length === 0 && prazosDoCnpj.length === 0) {
    return naoRespondivel(
      'prazos_e_pendencias',
      tier,
      'Não há pendência nem prazo a vencer nos próximos 30 dias para este CNPJ.' +
        (calendario.normative_rules_loaded
          ? ''
          : ' Atenção: nenhum prazo normativo está carregado no sistema, então a ' +
            'ausência de prazo aqui não significa que não existe prazo.'),
    );
  }

  const claims: Claim[] = [];

  for (const pendencia of doCnpj) {
    claims.push(
      fact(
        `${pendencia.name} (${pendencia.severity}): há ${pendencia.daysOpen} dia(s). ` +
          pendencia.message,
        [evidencia.add(periodCitation(pendencia.period))],
      ),
    );
  }

  for (const prazo of prazosDoCnpj) {
    claims.push(
      fact(
        `${prazo.name} vence em ${prazo.due_date} (${prazo.days_left} dia(s)).` +
          (prazo.legal_basis === null ? '' : ` Base: ${prazo.legal_basis}.`),
        [evidencia.add(periodCitation(prazo.period ?? prazo.due_date.slice(0, 7)))],
      ),
    );
  }

  if (!calendario.normative_rules_loaded) {
    claims.push(
      explanation(
        'Nenhum prazo normativo está carregado no sistema. A lista acima traz ' +
          'pendências derivadas do estado do sistema e datas que ele conhece de fato, ' +
          'mas não prazos de norma — e lista vazia de prazo normativo significa "nada ' +
          'carregado", não "nada a vencer".',
      ),
    );
  }

  return {
    intent: 'prazos_e_pendencias',
    tier,
    confidence: calendario.normative_rules_loaded ? 'high' : 'medium',
    answerable: true,
    claims,
    suggested: [
      {
        action: 'consulta',
        method: 'GET',
        endpoint: '/v1/deadlines',
        rationale: 'O calendário da carteira inteira, com prazos e pendências separados.',
      },
    ],
  };
  }
