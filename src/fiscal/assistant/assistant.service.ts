import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import { classify, PERGUNTAS_SUPORTADAS, type Classification } from './intent-classifier.js';
import { routeTier, type LanguageModelPort } from './language-model.port.js';
import {
  assertGrounded,
  Evidence,
  type Answer,
  type Claim,
  type Confidence,
  type SuggestedIntention,
} from './grounding.js';
import { resumoDaResposta } from './answers/support.js';
import {
  documentos,
  estadoDaCompetencia,
  porQueNaoDeterminavel,
  valorDevido,
} from './answers/assessment.js';
import { divergencias, historico, prazos, saudeDoCadastro } from './answers/audit.js';

export interface Thread {
  id: string;
  cnpj: string;
  title: string;
  created_at: string;
  messages_count: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: string | null;
  tier: number | null;
  confidence: Confidence | null;
  answerable: boolean | null;
  claims: Claim[];
  suggested: SuggestedIntention[];
  created_at: string;
}

export interface Usage {
  used: number;
  allowance: number;
  remaining: number;
}

export class AssistantNotInPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantNotInPlanError';
  }
}

export class AssistantQuotaError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
  ) {
    super(message);
    this.name = 'AssistantQuotaError';
  }
}

export class ThreadNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadNotFoundError';
  }
}

/**
 * Assistente fiscal somente leitura — diferencial #6.
 *
 * Duas propriedades estruturais, e não de convenção:
 *
 * 1. **Não recebe orquestrador.** O construtor toma um `Pool` e nada mais, então
 *    não existe caminho de código daqui até o log fiscal. "O assistente não
 *    escreve evento" não é uma regra a ser respeitada: é uma dependência que não
 *    está aqui.
 * 2. **Toda afirmação factual passa por `assertGrounded`** contra as evidências
 *    que a consulta trouxe, antes de sair do serviço. Citação inventada é
 *    recusada mecanicamente — inclusive se vier de um modelo de linguagem.
 *
 * As tabelas deste módulo (`assistant_threads`, `assistant_messages`) são
 * conversa, não apuração, e gravar nelas não move número fiscal nenhum.
 */
export class AssistantService {
  constructor(
    private readonly pool: Pool,
    private readonly model?: LanguageModelPort,
  ) {}

  async usage(scope: EventScope): Promise<Usage> {
    const { rows } = await this.pool.query<{
      used: string;
      allowance: string;
      remaining: string;
    }>('select used, allowance, remaining from assistant_usage($1::uuid, $2::char(14))', [
      scope.tenantId,
      scope.cnpj,
    ]);

    const linha = rows[0];
    return {
      used: Number(linha?.used ?? 0),
      allowance: Number(linha?.allowance ?? 0),
      remaining: Number(linha?.remaining ?? 0),
    };
  }

  async createThread(scope: EventScope, title: string, userId: string | null): Promise<Thread> {
    await this.assertInPlan(scope);

    const { rows } = await this.pool.query<{ id: string; created_at: string }>(
      `insert into assistant_threads (tenant_id, cnpj, title, created_by)
       values ($1::uuid, $2::char(14), $3, $4::uuid)
       returning id, created_at`,
      [scope.tenantId, scope.cnpj, title, userId],
    );

    return {
      id: rows[0]!.id,
      cnpj: scope.cnpj,
      title,
      created_at: new Date(rows[0]!.created_at).toISOString(),
      messages_count: 0,
    };
  }

  async listThreads(scope: EventScope): Promise<Thread[]> {
    const { rows } = await this.pool.query<{
      id: string;
      title: string;
      created_at: string;
      total: string;
    }>(
      `select t.id, t.title, t.created_at,
              (select count(*)::text from assistant_messages m where m.thread_id = t.id) as total
         from assistant_threads t
        where t.tenant_id = $1::uuid and t.cnpj = $2::char(14)
        order by t.created_at desc`,
      [scope.tenantId, scope.cnpj],
    );

    return rows.map((r) => ({
      id: r.id,
      cnpj: scope.cnpj,
      title: r.title,
      created_at: new Date(r.created_at).toISOString(),
      messages_count: Number(r.total),
    }));
  }

  async messages(scope: EventScope, threadId: string): Promise<Message[]> {
    await this.assertThread(scope, threadId);

    const { rows } = await this.pool.query(
      `select id, role, content, intent, tier, confidence, answerable, claims, suggested, created_at
         from assistant_messages
        where thread_id = $1::uuid and tenant_id = $2::uuid
        order by created_at, id`,
      [threadId, scope.tenantId],
    );

    return rows.map((r: Record<string, unknown>) => ({
      id: String(r['id']),
      role: r['role'] as 'user' | 'assistant',
      content: String(r['content']),
      intent: (r['intent'] ?? null) as string | null,
      tier: r['tier'] === null ? null : Number(r['tier']),
      confidence: (r['confidence'] ?? null) as Confidence | null,
      answerable: (r['answerable'] ?? null) as boolean | null,
      claims: (r['claims'] ?? []) as Claim[],
      suggested: (r['suggested'] ?? []) as SuggestedIntention[],
      created_at: new Date(String(r['created_at'])).toISOString(),
    }));
  }

  /**
   * Responde uma pergunta.
   *
   * A pergunta do usuário é gravada **antes** da resposta e conta para a cota
   * mesmo que a resposta saia como não respondível: perguntar consome trabalho
   * de consulta, e não cobrar pelo "não sei" abriria caminho para contornar o
   * limite fazendo perguntas que o sistema não entende.
   */
  async ask(
    scope: EventScope,
    threadId: string,
    question: string,
    userId: string | null,
  ): Promise<{ answer: Answer; usage: Usage }> {
    await this.assertThread(scope, threadId);
    const cota = await this.assertQuota(scope);

    await this.pool.query(
      `insert into assistant_messages (thread_id, tenant_id, cnpj, role, content, created_by)
       values ($1::uuid, $2::uuid, $3::char(14), 'user', $4, $5::uuid)`,
      [threadId, scope.tenantId, scope.cnpj, question, userId],
    );

    const classificacao = classify(question);
    const evidencia = new Evidence();
    const answer = await this.build(scope, classificacao, evidencia);

    // A checagem roda aqui, e não na borda: uma resposta sem lastro não deve
    // nem chegar a ser gravada.
    assertGrounded(answer, evidencia);

    await this.pool.query(
      `insert into assistant_messages (
         thread_id, tenant_id, cnpj, role, content, intent, tier, confidence,
         answerable, claims, suggested
       ) values ($1::uuid, $2::uuid, $3::char(14), 'assistant', $4, $5, $6, $7, $8,
                 $9::jsonb, $10::jsonb)`,
      [
        threadId,
        scope.tenantId,
        scope.cnpj,
        resumoDaResposta(answer),
        answer.intent,
        answer.tier,
        answer.confidence,
        answer.answerable,
        JSON.stringify(answer.claims),
        JSON.stringify(answer.suggested),
      ],
    );

    return {
      answer,
      usage: { ...cota, used: cota.used + 1, remaining: Math.max(cota.remaining - 1, 0) },
    };
  }

  // ------------------------------------------------------ construção

  private async build(
    scope: EventScope,
    classificacao: Classification,
    evidencia: Evidence,
  ): Promise<Answer> {
    const tier = routeTier(classificacao.intent);

    if (classificacao.intent === 'desconhecido') {
      return this.semIntencao(tier);
    }

    const period = classificacao.period ?? (await this.periodoRelevante(scope));

    if (period === undefined && classificacao.intent !== 'prazos_e_pendencias') {
      return {
        intent: classificacao.intent,
        tier,
        confidence: 'high',
        answerable: false,
        claims: [],
        suggested: [
          {
            action: 'period.opened',
            method: 'POST',
            endpoint: `/v1/clients/${scope.cnpj}/periods`,
            payload: { period: 'YYYY-MM' },
            rationale: 'Nenhuma competência foi aberta para este CNPJ ainda.',
          },
        ],
        unanswerableReason:
          'Este CNPJ não tem competência aberta, então não há mês sobre o qual responder.',
      };
    }

    switch (classificacao.intent) {
      case 'estado_da_competencia':
        return estadoDaCompetencia(this.pool, scope, period!, tier, evidencia);
      case 'valor_devido':
        return valorDevido(this.pool, scope, period!, classificacao.tax, tier, evidencia);
      case 'por_que_nao_determinavel':
        return porQueNaoDeterminavel(this.pool, scope, period!, tier, evidencia);
      case 'divergencias_do_fisco':
        return divergencias(this.pool, scope, period!, tier, evidencia);
      case 'saude_do_cadastro':
        return saudeDoCadastro(this.pool, scope, tier, evidencia);
      case 'documentos_do_periodo':
        return documentos(this.pool, scope, period!, tier, evidencia);
      case 'historico_do_documento':
        return historico(this.pool, scope, classificacao.accessKey, tier, evidencia);
      case 'prazos_e_pendencias':
        return prazos(this.pool, scope, tier, evidencia);
    }
  }

  /**
   * Sem intenção reconhecida, a resposta é "não entendi, e eis o que sei".
   *
   * É onde entraria a camada 3. Sem provedor configurado, dizer o que não sabe
   * responder é verdadeiro; devolver algo plausível seria o modo de falha que
   * este produto não pode ter.
   */
  private semIntencao(tier: 1 | 3): Answer {
    const suportadas = Object.values(PERGUNTAS_SUPORTADAS);

    return {
      intent: 'desconhecido',
      tier,
      confidence: 'high',
      answerable: false,
      claims: [],
      suggested: [],
      unanswerableReason:
        (this.model === undefined
          ? 'Não reconheci a pergunta, e não há modelo de linguagem configurado para ' +
            'interpretá-la. '
          : `Não reconheci a pergunta, e o modelo ${this.model.name} não encontrou ` +
            'lastro nos dados deste CNPJ para responder. ') +
        `Sei responder: ${suportadas.map((s) => `(${s})`).join('; ')}.`,
    };
  }

  // ------------------------------------------------------------ apoio

  /** A competência mais recente que ainda não fechou; sem nenhuma, a última. */
  private async periodoRelevante(scope: EventScope): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ period: string }>(
      `select period from periods
        where tenant_id = $1::uuid and cnpj = $2::char(14)
        order by (state <> 'confirmed') desc, period desc
        limit 1`,
      [scope.tenantId, scope.cnpj],
    );

    return rows[0] === undefined ? undefined : String(rows[0].period).trim();
  }

  private async assertInPlan(scope: EventScope): Promise<Usage> {
    const cota = await this.usage(scope);

    if (cota.allowance === 0) {
      throw new AssistantNotInPlanError(
        'O assistente fiscal não está incluído no plano deste CNPJ. O limite mensal ' +
          'vem do plano do regime, e para este regime ele é zero.',
      );
    }

    return cota;
  }

  private async assertQuota(scope: EventScope): Promise<Usage> {
    const cota = await this.assertInPlan(scope);

    if (cota.remaining <= 0) {
      throw new AssistantQuotaError(
        `Limite de ${cota.allowance} pergunta(s) por mês para este CNPJ já foi atingido ` +
          `(${cota.used} usadas).`,
        cota,
      );
    }

    return cota;
  }

  private async assertThread(scope: EventScope, threadId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `select 1 from assistant_threads
        where id = $1::uuid and tenant_id = $2::uuid and cnpj = $3::char(14)`,
      [threadId, scope.tenantId, scope.cnpj],
    );

    if (rows.length === 0) {
      throw new ThreadNotFoundError(`Conversa ${threadId} não encontrada para este CNPJ.`);
    }
  }
}
