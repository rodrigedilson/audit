import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { readXmlUpload } from '../multipart.js';
import { createBurstLimiter, RateLimitedError } from '../plugins/rate-limit.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { PublicInputError } from '../public-errors.js';
import { summarizeReadiness, type ReadinessReport } from '../../fiscal/ingestion/readiness.js';

/**
 * Superfície anônima da API.
 *
 * Fica num arquivo só dela de propósito. Em `ingestion.routes.ts` tudo é
 * autenticado e escopado por escritório; pôr uma rota anônima no meio convidaria
 * a próxima pessoa a copiar o handler errado. Aqui o que se revisa é abuso.
 */

/**
 * Teto de arquivos do diagnóstico. Bem menor que os 200 da ingestão
 * autenticada: esta rota não tem dono e o parsing de XML é síncrono e
 * CPU-bound — 200 arquivos de 5 MB por requisição anônima congelariam o
 * event loop.
 */
const MAX_ARQUIVOS = 50;
const MAX_BYTES_DO_LOTE = 10 * 1024 * 1024;

/** Rajada: pega script ingênuo e duplo-clique sem ir ao banco. */
const RAJADA = { windowMs: 60_000, max: 3 };

/** Quota diária, conferida no banco: atravessa instâncias e reinícios. */
const QUOTA_DIARIA = 20;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function registerPublicRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const rajada = createBurstLimiter(RAJADA);

  /**
   * `POST /reform-readiness` — diagnóstico de prontidão da carteira.
   *
   * Responde **200**, e não 207 como a ingestão. O contraste é proposital: lá
   * cada arquivo tem efeito individual (entrou ou não no log), e o 207 diz quais
   * entraram. Aqui nada é gravado — o relatório está completo mesmo com
   * rejeições, e as rejeições são *dado do diagnóstico* ("2 dos seus 50 XMLs nem
   * abrem"), não falha parcial da requisição.
   */
  app.post('/reform-readiness', async (request, reply) => {
    if (!deps.env.publicDiagnosticEnabled) {
      // Killswitch: rota anônima e CPU-bound precisa poder ser desligada sem
      // rollback. Mesmo padrão do webhook do Asaas sem token.
      return reply.code(503).send({
        code: 'diagnostic_disabled',
        message: 'O diagnóstico público está temporariamente indisponível.',
      });
    }

    const ipHash = hashDoIp(request, deps.env.certificateMasterKey);

    const veredito = rajada.hit(ipHash);
    if (!veredito.allowed) {
      throw new RateLimitedError(
        veredito.retryAfterSeconds,
        'Muitos diagnósticos seguidos. Aguarde alguns instantes.',
      );
    }

    await exigirQuotaDiaria(deps, ipHash);

    /**
     * `readXmlUpload` é compartilhado com a ingestão autenticada, onde recusar
     * com camada e motivo está certo — lá quem lê é um contador. Aqui a recusa
     * é traduzida na fronteira, para o visitante ler "Máximo de 50 arquivos" e
     * não o vocabulário do pipeline.
     */
    let files;
    let fields;
    try {
      ({ files, fields } = await readXmlUpload(request, {
        maxFiles: MAX_ARQUIVOS,
        maxTotalBytes: MAX_BYTES_DO_LOTE,
        allowedFields: ['email', 'consent', 'source'],
      }));
    } catch (erro) {
      if (erro instanceof ValidationError) {
        throw new PublicInputError(erro.details);
      }
      throw erro;
    }

    // O e-mail é validado ANTES de gastar CPU com o lote: um endereço
    // malformado não justifica 50 parses.
    const email = fields['email']?.trim();
    if (email && !EMAIL.test(email)) {
      throw new PublicInputError('E-mail inválido.');
    }
    const consentiu = fields['consent'] === 'true' || fields['consent'] === '1';

    const relatorio = summarizeReadiness(files);

    const leadRegistrado = Boolean(email) && consentiu;
    const reportId = await registrarMetrica(deps, {
      ipHash,
      relatorio,
      ...(leadRegistrado && email ? { email } : {}),
      ...(fields['source'] ? { source: fields['source'] } : {}),
    });

    return reply.code(200).send({
      /**
       * Identifica este diagnóstico para o envio do relatório por e-mail, que
       * acontece depois — a tela mostra o resultado primeiro, e só então
       * oferece o envio. Sem este id a tela teria de reenviar os XMLs só para
       * registrar um endereço.
       */
      report_id: reportId,
      generated_at: new Date().toISOString(),
      ...serializar(relatorio),
      limits: { max_files: MAX_ARQUIVOS, max_total_bytes: MAX_BYTES_DO_LOTE },
      // Literal e proposital: é o compromisso do produto dito na própria
      // resposta, e é o que um teste consegue afirmar.
      persisted: false,
      lead_registered: leadRegistrado,
    });
  });

  /**
   * `POST /reform-readiness/{report_id}/lead` — anexa o e-mail a um diagnóstico
   * que já foi feito.
   *
   * Existe porque a tela correta mostra o relatório **primeiro** e só então
   * oferece enviá-lo por e-mail. Sem esta rota, registrar o endereço obrigava a
   * reenviar os mesmos XMLs: parsing duplicado, e uma segunda linha de métrica
   * para o mesmo diagnóstico, inflando o funil.
   *
   * O `report_id` é um UUID v4 — não é enumerável, e o único efeito de acertar
   * um palpite é anexar um e-mail a um contador anônimo. A função no banco
   * recusa sobrescrever lead já gravado, então reenviar o formulário não troca
   * o endereço nem a data de consentimento.
   *
   * O id vai no **corpo**, e não no caminho, porque o hook de autenticação
   * reconhece rota pública por igualdade exata de URL. Uma rota com parâmetro
   * no caminho nunca casaria com a lista, e cairia na verificação de token —
   * numa rota que, por definição, não tem sessão.
   */
  app.post<{ Body: { report_id: string; email: string; consent: boolean; source?: string } }>(
    '/reform-readiness/lead',
    {
      schema: {
        body: {
          type: 'object',
          required: ['report_id', 'email', 'consent'],
          properties: {
            report_id: { type: 'string', format: 'uuid' },
            email: { type: 'string', maxLength: 254 },
            consent: { type: 'boolean' },
            source: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!deps.env.publicDiagnosticEnabled) {
        return reply.code(503).send({
          code: 'diagnostic_disabled',
          message: 'O diagnóstico público está temporariamente indisponível.',
        });
      }

      const ipHash = hashDoIp(request, deps.env.certificateMasterKey);
      const veredito = rajada.hit(`lead:${ipHash}`);
      if (!veredito.allowed) {
        throw new RateLimitedError(
          veredito.retryAfterSeconds,
          'Muitos envios seguidos. Aguarde alguns instantes.',
        );
      }

      const email = request.body.email.trim();
      if (!EMAIL.test(email)) {
        throw new PublicInputError('E-mail inválido.');
      }

      // Consentimento é condição, não caixa de sugestão: sem ele não há base
      // para guardar o endereço, e a constraint do banco recusaria de todo jeito.
      if (request.body.consent !== true) {
        throw new PublicInputError('É preciso consentir com o envio para registrar o e-mail.');
      }

      const { rows } = await deps.pool.query<{ registrar_lead_do_diagnostico: boolean }>(
        'select registrar_lead_do_diagnostico($1::uuid, $2::text, $3::text)',
        [request.body.report_id, email, request.body.source ?? null],
      );

      if (rows[0]?.registrar_lead_do_diagnostico !== true) {
        // 404 tanto para id inexistente quanto para diagnóstico que já tem
        // lead: distinguir os dois confirmaria a existência de um id a quem
        // está chutando.
        return reply.code(404).send({
          code: 'not_found',
          message: 'Diagnóstico não encontrado ou já registrado.',
        });
      }

      return reply.code(200).send({ lead_registered: true });
    },
  );
}

/**
 * Hash do IP do visitante.
 *
 * O salt deriva da chave mestra por separação de domínio: é determinístico entre
 * instâncias e reinícios — sem isso a quota diária não funcionaria — e não expõe
 * a chave nem reusa o mesmo material do cofre de certificados.
 */
function hashDoIp(request: FastifyRequest, masterKey: string): string {
  const salt = createHash('sha256').update(`public-diagnostic-ip-hash:${masterKey}`).digest('hex');
  return createHash('sha256').update(`${salt}:${request.ip}`).digest('hex');
}

async function exigirQuotaDiaria(deps: ApiDeps, ipHash: string): Promise<void> {
  // O `retry_after` é o tempo até o diagnóstico mais antigo da janela vencer, e
  // não uma hora fixa: é quando de fato abre uma vaga.
  const { rows } = await deps.pool.query<{ usadas: string; libera_em: string | null }>(
    `select count(*) as usadas,
            extract(epoch from (min(created_at) + interval '1 day' - now()))::text as libera_em
       from readiness_reports
      where ip_hash = $1::char(64) and created_at > now() - interval '1 day'`,
    [ipHash],
  );

  if (Number(rows[0]?.usadas ?? 0) >= QUOTA_DIARIA) {
    // O brief é explícito: o 429 não é tela de upgrade. Diz o limite e quando
    // tentar de novo, e nada mais.
    throw new RateLimitedError(
      Math.max(1, Math.ceil(Number(rows[0]?.libera_em ?? 3600))),
      `Você fez muitos diagnósticos hoje (limite de ${QUOTA_DIARIA} por dia). ` +
        'Tente de novo mais tarde.',
    );
  }
}

interface MetricaArgs {
  ipHash: string;
  relatorio: ReadinessReport;
  email?: string;
  source?: string;
}

/** Só contadores. Nenhuma coluna guarda dado do documento do visitante. */
async function registrarMetrica(deps: ApiDeps, args: MetricaArgs): Promise<string> {
  const { relatorio } = args;

  const { rows } = await deps.pool.query<{ id: string }>(
    `insert into readiness_reports (
       ip_hash, documents_total, documents_parsed, documents_rejected,
       documents_with_reform, items_total, items_with_reform,
       distinct_issuers, distinct_ncms, periods_covered,
       email, email_consent_at, source
     ) values ($1::char(64), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               case when $11::text is null then null else now() end, $12)
     returning id`,
    [
      args.ipHash,
      relatorio.totals.documents,
      relatorio.totals.parsed,
      relatorio.totals.rejected,
      relatorio.documentsReady.ready,
      relatorio.itemsReady.total,
      relatorio.itemsReady.ready,
      relatorio.issuers.length,
      relatorio.ncms.length,
      relatorio.periods.length,
      args.email ?? null,
      args.source ?? null,
    ],
  );

  return rows[0]!.id;
}

function serializar(relatorio: ReadinessReport): Record<string, unknown> {
  const razao = (r: { total: number; ready: number; readyPct: number }) => ({
    total: r.total,
    ready: r.ready,
    ready_pct: r.readyPct,
  });

  return {
    totals: relatorio.totals,
    documents_ready: razao(relatorio.documentsReady),
    items_ready: razao(relatorio.itemsReady),
    value_ready: {
      total_cents: relatorio.valueReady.totalCents,
      ready_cents: relatorio.valueReady.readyCents,
      ready_pct: relatorio.valueReady.readyPct,
    },
    periods: relatorio.periods.map((p) => ({ period: p.period, documents: razao(p.documents) })),
    issuers: relatorio.issuers.map((e) => ({
      cnpj: e.cnpj,
      name: e.name,
      documents: razao(e.documents),
      total_cents: e.totalCents,
    })),
    issuers_truncated: relatorio.issuersTruncated,
    ncms: relatorio.ncms.map((n) => ({ ncm: n.ncm, items: razao(n.items) })),
    ncms_truncated: relatorio.ncmsTruncated,
    rejections: relatorio.rejections,
  };
}
