import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../server.js';
import { readXmlUpload } from '../multipart.js';
import { createBurstLimiter, RateLimitedError } from '../plugins/rate-limit.js';
import { ValidationError } from '../../esaa/shared/types/esaa-errors.js';
import { PublicInputError } from '../public-errors.js';
import { summarizeReadiness, type ReadinessReport } from '../../fiscal/ingestion/readiness.js';
import type { DeliveryOutcome } from '../../fiscal/ingestion/readiness-delivery.js';

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

    const ipHash = hashDoIp(request, deps.env);

    const veredito = rajada.hit(ipHash);
    if (!veredito.allowed) {
      throw new RateLimitedError(
        veredito.retryAfterSeconds,
        'Muitos diagnósticos seguidos. Aguarde alguns instantes.',
      );
    }

    // A vaga da quota é reservada antes do parsing, na mesma transação da
    // contagem: vinte requisições simultâneas não passam todas pela contagem.
    const reportId = await reservarDiagnostico(deps, ipHash);

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
      await liberarVaga(deps, reportId);
      if (erro instanceof ValidationError) {
        throw new PublicInputError(erro.details);
      }
      throw erro;
    }

    // O e-mail é validado ANTES de gastar CPU com o lote: um endereço
    // malformado não justifica 50 parses.
    const email = fields['email']?.trim();
    if (email && !EMAIL.test(email)) {
      await liberarVaga(deps, reportId);
      throw new PublicInputError('E-mail inválido.');
    }
    const consentiu = fields['consent'] === 'true' || fields['consent'] === '1';

    const relatorio = summarizeReadiness(files);

    const leadRegistrado = Boolean(email) && consentiu;
    await registrarMetrica(deps, reportId, {
      relatorio,
      ...(leadRegistrado && email ? { email } : {}),
      ...(fields['source'] ? { source: fields['source'] } : {}),
    });

    const entrega = deps.readinessDelivery;
    await entrega.purgeExpired();
    const guardadoAte = await entrega.store(reportId, relatorio);
    const envio = leadRegistrado ? await entrega.send(reportId) : undefined;

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
      /**
       * O compromisso do produto dito na própria resposta: os XMLs nunca são
       * guardados. O resumo que a tela mostra fica cifrado até `summary_until`
       * (24h), só para o envio por e-mail, e é apagado assim que sai.
       */
      persisted: {
        documents: false,
        summary_until: guardadoAte?.toISOString() ?? null,
      },
      lead_registered: leadRegistrado,
      ...(envio === undefined ? {} : descreverEnvio(envio)),
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

      const ipHash = hashDoIp(request, deps.env);
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

      const entrega = deps.readinessDelivery;
      await entrega.purgeExpired();

      // Com envio configurado, relatório vencido é 410 e o lead não é gravado:
      // registrar um e-mail para um relatório que não vai sair seria prometer o
      // que não se cumpre.
      if (entrega.enabled) {
        const disponivel = await entrega.availability(request.body.report_id);
        if (disponivel === 'expired') {
          return reply.code(410).send({
            code: 'report_expired',
            message:
              'O relatório deste diagnóstico não está mais guardado: ele fica no máximo 24 horas. ' +
              'Gere o diagnóstico de novo para recebê-lo por e-mail.',
          });
        }
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

      const envio = await entrega.send(request.body.report_id);
      return reply.code(200).send({ lead_registered: true, ...descreverEnvio(envio) });
    },
  );

  /**
   * `GET /reform-readiness/forget?token=` — o link "apagar meu e-mail" do
   * relatório enviado. Apaga e-mail, consentimento e o que restar do relatório.
   * Responde uma página curta, porque quem abre é uma pessoa no navegador.
   */
  app.get<{ Querystring: { token?: string } }>(
    '/reform-readiness/forget',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { token: { type: 'string', minLength: 20, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const veredito = rajada.hit(`forget:${hashDoIp(request, deps.env)}`);
      if (!veredito.allowed) {
        throw new RateLimitedError(veredito.retryAfterSeconds, 'Muitas tentativas. Aguarde alguns instantes.');
      }
      const token = request.query.token ?? '';
      const apagado = token !== '' && (await deps.readinessDelivery.forget(token));
      return reply
        .code(apagado ? 200 : 404)
        .type('text/html; charset=utf-8')
        .send(
          pagina(
            apagado
              ? 'Pronto: o seu e-mail foi apagado da nossa base, junto com o consentimento.'
              : 'Este link não vale mais: ou o e-mail já foi apagado, ou o endereço está incompleto.',
          ),
        );
    },
  );
}

function descreverEnvio(envio: DeliveryOutcome): { email_sent: boolean; email_not_sent_reason?: string } {
  return envio.sent ? { email_sent: true } : { email_sent: false, email_not_sent_reason: envio.reason };
}

function pagina(mensagem: string): string {
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Remoção de e-mail</title></head>' +
    `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${mensagem}</p></body></html>`
  );
}

/**
 * Hash do IP do visitante.
 *
 * HMAC com `IP_HASH_SECRET`: determinístico entre instâncias e reinícios — sem
 * isso a quota diária não funcionaria — e desacoplado da chave dos
 * certificados. Sem o segredo, o sal deriva da chave mestra por separação de
 * domínio, como antes, para a quota não zerar num deploy sem a variável.
 */
function hashDoIp(request: FastifyRequest, env: ApiDeps['env']): string {
  if (env.ipHashSecret !== undefined) {
    return createHmac('sha256', env.ipHashSecret).update(`public-diagnostic-ip:${request.ip}`).digest('hex');
  }
  const salt = createHash('sha256').update(`public-diagnostic-ip-hash:${env.certificateMasterKey}`).digest('hex');
  return createHash('sha256').update(`${salt}:${request.ip}`).digest('hex');
}

/**
 * Reserva a vaga da quota diária e devolve o id do diagnóstico.
 *
 * Contagem e inserção na mesma transação, sob um lock por `ip_hash`: sem isso,
 * requisições simultâneas passavam todas pela contagem antes de qualquer uma
 * gravar, e a quota de 20 virava a quantidade de abas abertas.
 */
async function reservarDiagnostico(deps: ApiDeps, ipHash: string): Promise<string> {
  const client = await deps.pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [ipHash]);

    // O `retry_after` é o tempo até o diagnóstico mais antigo da janela vencer, e
    // não uma hora fixa: é quando de fato abre uma vaga.
    const { rows } = await client.query<{ usadas: string; libera_em: string | null }>(
      `select count(*) as usadas,
              extract(epoch from (min(created_at) + interval '1 day' - now()))::text as libera_em
         from readiness_reports
        where ip_hash = $1::char(64) and created_at > now() - interval '1 day'`,
      [ipHash],
    );

    if (Number(rows[0]?.usadas ?? 0) >= QUOTA_DIARIA) {
      await client.query('rollback');
      // O brief é explícito: o 429 não é tela de upgrade. Diz o limite e quando
      // tentar de novo, e nada mais.
      throw new RateLimitedError(
        Math.max(1, Math.ceil(Number(rows[0]?.libera_em ?? 3600))),
        `Você fez muitos diagnósticos hoje (limite de ${QUOTA_DIARIA} por dia). ` +
          'Tente de novo mais tarde.',
      );
    }

    const { rows: nova } = await client.query<{ id: string }>(
      'insert into readiness_reports (ip_hash) values ($1::char(64)) returning id',
      [ipHash],
    );
    await client.query('commit');
    return nova[0]!.id;
  } catch (erro) {
    if (!(erro instanceof RateLimitedError)) {
      await client.query('rollback').catch(() => undefined);
    }
    throw erro;
  } finally {
    client.release();
  }
}

/** Upload recusado antes do parsing não gasta a quota do visitante. */
async function liberarVaga(deps: ApiDeps, reportId: string): Promise<void> {
  await deps.pool.query('delete from readiness_reports where id = $1::uuid', [reportId]);
}

interface MetricaArgs {
  relatorio: ReadinessReport;
  email?: string;
  source?: string;
}

/** Só contadores, e o lead consentido. O relatório em si vai cifrado, à parte. */
async function registrarMetrica(deps: ApiDeps, reportId: string, args: MetricaArgs): Promise<void> {
  const { relatorio } = args;

  await deps.pool.query(
    `update readiness_reports
        set documents_total = $2, documents_parsed = $3, documents_rejected = $4,
            documents_with_reform = $5, items_total = $6, items_with_reform = $7,
            distinct_issuers = $8, distinct_ncms = $9, periods_covered = $10,
            email = $11, email_consent_at = case when $11::text is null then null else now() end,
            source = $12
      where id = $1::uuid`,
    [
      reportId,
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
