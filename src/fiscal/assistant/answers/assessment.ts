import type { Pool } from 'pg';
import type { EventScope } from '../../../esaa/core/event-store/value-objects/event-scope.vo.js';
import {
  eventCitation,
  explanation,
  fact,
  periodCitation,
  type Answer,
  type Claim,
  type Evidence,
} from '../grounding.js';
import { brl, FALTA_PARA_AVANCAR, naoRespondivel, rotuloDeEstado, type TaxTotalsRow } from './support.js';

/**
 * Respostas sobre a competência e a apuração.
 *
 * Cada função consulta o que precisa, **registra a evidência no `Evidence` antes
 * de escrever o texto** e devolve afirmações já citadas. A ordem importa: quem
 * redige só pode citar o que a consulta trouxe, e `assertGrounded` confere isso
 * no serviço.
 */

export async function estadoDaCompetencia(
  pool: Pool,
  scope: EventScope,
  period: string,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  const { rows } = await pool.query<{
    state: string;
    projection_hash: string | null;
    ultimo_seq: string | null;
  }>(
    `select p.state, p.projection_hash,
            (select max(e.event_seq)::text from events e
              where e.tenant_id = p.tenant_id and e.cnpj = p.cnpj and e.period = p.period)
            as ultimo_seq
       from periods p
      where p.tenant_id = $1::uuid and p.cnpj = $2::char(14) and p.period = $3::char(7)`,
    [scope.tenantId, scope.cnpj, period],
  );

  const linha = rows[0];
  if (!linha) {
    return naoRespondivel(
      'estado_da_competencia',
      tier,
      `A competência ${period} não foi aberta para este CNPJ.`,
    );
  }

  const citacoes = [evidencia.add(periodCitation(period))];
  if (linha.ultimo_seq !== null) {
    citacoes.push(evidencia.add(eventCitation(Number(linha.ultimo_seq), 'último evento do mês')));
  }

  const claims: Claim[] = [
    fact(`A competência ${period} está em "${rotuloDeEstado(linha.state)}".`, citacoes),
  ];

  const falta = FALTA_PARA_AVANCAR[linha.state];
  claims.push(explanation(falta.texto));

  return {
    intent: 'estado_da_competencia',
    tier,
    confidence: 'high',
    answerable: true,
    claims,
    suggested: falta.sugestao(scope.cnpj, period),
  };
  }

export async function valorDevido(
  pool: Pool,
  scope: EventScope,
  period: string,
  tax: string | undefined,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  // Sem `total_due_cents`: o total devido é calculado a partir dos tributos, e
  // não persistido. Cada tributo é afirmado separadamente aqui de propósito —
  // um total único esconderia qual deles é o indeterminado.
  const { rows } = await pool.query<{
    totals: Record<string, TaxTotalsRow>;
    event_seq: string;
  }>(
    `select totals, event_seq
       from assessments
      where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
    [scope.tenantId, scope.cnpj, period],
  );

  const linha = rows[0];
  if (!linha) {
    return naoRespondivel(
      'valor_devido',
      tier,
      `A competência ${period} não foi apurada, então não há débito, crédito nem ` +
        'valor devido para informar.',
      [
        {
          action: 'assessment.projected',
          method: 'POST',
          endpoint: `/v1/clients/${scope.cnpj}/assessments/${period}`,
          rationale: 'Apurar a competência produz os valores a partir dos documentos.',
        },
      ],
    );
  }

  const base = [
    evidencia.add(periodCitation(period)),
    evidencia.add(eventCitation(Number(linha.event_seq), 'apuração da competência')),
  ];

  const tributos = Object.entries(linha.totals).filter(
    ([nome, t]) =>
      (tax === undefined || nome === tax) &&
      (Number(t.debitsCents) !== 0 || Number(t.potentialCreditsCents) !== 0),
  );

  if (tributos.length === 0) {
    return naoRespondivel(
      'valor_devido',
      tier,
      tax === undefined
        ? `Nenhum tributo foi destacado nos documentos da competência ${period}.`
        : `Nenhum valor de ${tax.toUpperCase()} foi destacado nos documentos da ` +
          `competência ${period}.`,
    );
  }

  const claims: Claim[] = [];
  let algumIndeterminado = false;

  for (const [nome, total] of tributos) {
    const devido = total.dueCents === null ? null : Number(total.dueCents);
    algumIndeterminado ||= devido === null;

    claims.push(
      fact(
        `${nome.toUpperCase()}: débito de ${brl(total.debitsCents)}, crédito potencial de ` +
          `${brl(total.potentialCreditsCents)}, devido ` +
          (devido === null ? '**não determinável**.' : `de ${brl(devido)}.`),
        base,
      ),
    );
  }

  if (algumIndeterminado) {
    claims.push(
      explanation(
        'Onde o devido está como não determinável, falta regra de creditamento ' +
          'publicada para o período. Débito e crédito potencial saem dos próprios ' +
          'documentos e não dependem de norma; decidir se o crédito é aproveitável, ' +
          'sim. Um número fiscal errado é pior do que um ausente.',
      ),
    );
  }

  return {
    intent: 'valor_devido',
    tier,
    // Média quando há indeterminado: a resposta está certa e incompleta, e
    // dizer "alta" faria o contador tratá-la como fechada.
    confidence: algumIndeterminado ? 'medium' : 'high',
    answerable: true,
    claims,
    suggested: algumIndeterminado
      ? [
          {
            action: 'consulta',
            method: 'GET',
            endpoint: `/v1/clients/${scope.cnpj}/assessments/${period}`,
            rationale:
              'A apuração completa lista em `not_computable` qual regra falta para ' +
              'cada tributo.',
          },
        ]
      : [],
  };
  }

export async function porQueNaoDeterminavel(
  pool: Pool,
  scope: EventScope,
  period: string,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  const { rows } = await pool.query<{
    not_computable: { subject: string; reason: string; message: string }[] | null;
    event_seq: string;
  }>(
    `select not_computable, event_seq
       from assessments
      where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
    [scope.tenantId, scope.cnpj, period],
  );

  const linha = rows[0];
  if (!linha) {
    return naoRespondivel(
      'por_que_nao_determinavel',
      tier,
      `A competência ${period} não foi apurada, então não há valor indeterminado ` +
        'para explicar.',
    );
  }

  const motivos = linha.not_computable ?? [];
  if (motivos.length === 0) {
    return naoRespondivel(
      'por_que_nao_determinavel',
      tier,
      `Nenhum valor da competência ${period} ficou indeterminado: todos os tributos ` +
        'com movimento têm regra aplicada.',
    );
  }

  const citacoes = [
    evidencia.add(periodCitation(period)),
    evidencia.add(eventCitation(Number(linha.event_seq), 'apuração da competência')),
  ];

  // Agrupado por motivo: dez itens sem grupo UB são um achado, não dez.
  const porMotivo = new Map<string, { subjects: string[]; message: string }>();
  for (const motivo of motivos) {
    const grupo = porMotivo.get(motivo.reason) ?? { subjects: [], message: motivo.message };
    grupo.subjects.push(motivo.subject);
    porMotivo.set(motivo.reason, grupo);
  }

  const claims: Claim[] = [];
  for (const [reason, grupo] of porMotivo) {
    const amostra = grupo.subjects.slice(0, 5).join(', ');
    const resto = grupo.subjects.length > 5 ? ` e outros ${grupo.subjects.length - 5}` : '';

    claims.push(
      fact(
        `${grupo.subjects.length} ocorrência(s) de "${reason}": ${amostra}${resto}. ` +
          grupo.message,
        citacoes,
      ),
    );
  }

  return {
    intent: 'por_que_nao_determinavel',
    tier,
    confidence: 'high',
    answerable: true,
    claims,
    suggested: [
      {
        action: 'rule.published',
        method: 'GET',
        endpoint: '/v1/tax-rules',
        rationale:
          'Publicar a regra de creditamento com a fonte normativa é o que torna o ' +
          'valor devido determinável.',
      },
    ],
  };
  }

export async function documentos(
  pool: Pool,
  scope: EventScope,
  period: string,
  tier: 1 | 3,
  evidencia: Evidence,
): Promise<Answer> {
  const { rows } = await pool.query<{
    direction: string;
    total: string;
    valor: string;
  }>(
    `select direction, count(*)::text as total, coalesce(sum(total_cents), 0)::text as valor
       from documents
      where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
        and cancelled_at is null
      group by direction`,
    [scope.tenantId, scope.cnpj, period],
  );

  if (rows.length === 0) {
    return naoRespondivel(
      'documentos_do_periodo',
      tier,
      `Nenhum documento foi ingerido na competência ${period}.`,
      [
        {
          action: 'doc.received',
          method: 'POST',
          endpoint: `/v1/clients/${scope.cnpj}/documents`,
          rationale: 'Ingerir os XMLs da competência é o primeiro passo do fechamento.',
        },
      ],
    );
  }

  const doPeriodo = evidencia.add(periodCitation(period));

  return {
    intent: 'documentos_do_periodo',
    tier,
    confidence: 'high',
    answerable: true,
    claims: rows.map((r) =>
      fact(
        `${r.total} documento(s) de ${r.direction === 'outbound' ? 'saída' : 'entrada'} ` +
          `na competência ${period}, somando ${brl(Number(r.valor))}.`,
        [doPeriodo],
      ),
    ),
    suggested: [],
  };
  }
