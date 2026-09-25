import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../infrastructure/persistence/pool-errors.js';
import type { Env } from '../config/env.js';
import { JwtVerifier } from './auth/jwt-verifier.js';
import { TenantResolver, type TenantContext } from './auth/tenant-resolver.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerPlanGate } from './plugins/plan-gate.js';
import { PlanFeatures } from '../billing/plan-features.js';
import { SmtpMailGateway, type MailGateway } from '../infrastructure/mail/mail-gateway.js';
import { ReadinessDelivery } from '../fiscal/ingestion/readiness-delivery.js';
import { ReadinessReportCipher } from '../fiscal/ingestion/readiness-cipher.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerPortfolioRoutes } from './routes/portfolio.routes.js';
import { registerEventRoutes } from './routes/events.routes.js';
import { registerCertificateRoutes } from './routes/certificate.routes.js';
import { registerBillingRoutes, registerBillingWebhook } from './routes/billing.routes.js';
import { registerIngestionRoutes } from './routes/ingestion.routes.js';
import { registerPublicRoutes } from './routes/public.routes.js';
import { registerCatalogRoutes } from './routes/catalog.routes.js';
import { registerAssessmentRoutes } from './routes/assessment.routes.js';
import { registerReportingRoutes } from './routes/reporting.routes.js';
import { registerReconciliationRoutes } from './routes/reconciliation.routes.js';
import { registerAssistantRoutes } from './routes/assistant.routes.js';
import { registerCreditRoutes } from './routes/credit.routes.js';
import { registerAuditRoutes } from './routes/audit.routes.js';
import { registerIndicesRoutes } from './routes/indices.routes.js';
import { registerSimulationRoutes } from './routes/simulation.routes.js';
import { registerDossierRoutes } from './routes/dossier.routes.js';
import { registerEfdIcmsIpiRoutes } from './routes/efd-icms-ipi.routes.js';
import { AsaasClient, type AsaasGateway } from '../billing/asaas-client.js';
import type { LanguageModelPort } from '../fiscal/assistant/language-model.port.js';
import { ClaudeLanguageModel } from '../fiscal/assistant/claude-language-model.js';
import { SefazSoapClient, type SefazDfeGateway } from '../fiscal/dfe/sefaz-gateway.js';
import { DfeSyncService } from '../fiscal/dfe/dfe-sync.service.js';
import { startDfeScheduler, startDfeWorker } from '../fiscal/dfe/dfe-worker.js';
import { startIndicesScheduler } from '../fiscal/rules/index-loader.js';
import { FiscalOrchestratorService } from '../esaa/orchestrator/fiscal-orchestrator.service.js';
import { ContractLoaderService } from '../esaa/core/contracts/contract-loader.service.js';
import { PostgresEventStoreRepository } from '../infrastructure/persistence/postgres-event-store.repository.js';
import type { EventScope } from '../esaa/core/event-store/value-objects/event-scope.vo.js';
import { loadConfig } from '../config/esaa-config.js';
import { createBurstLimiter, exigirLimite } from './plugins/rate-limit.js';
import {
  criarTrilhaDeSeguranca,
  type SecurityTrail,
} from '../infrastructure/security/security-trail.js';
import { Logger } from '../esaa/shared/infrastructure/logger.js';
import { startSecurityTrailPruner } from '../infrastructure/security/security-trail-retention.js';
import { randomUUID } from 'node:crypto';

export interface ApiDeps {
  env: Env;
  pool: pg.Pool;
  jwtVerifier: JwtVerifier;
  tenantResolver: TenantResolver;
  /**
   * Um orquestrador por escopo de requisição. Não é cache: a projeção em memória
   * é do CNPJ que ele serve, e compartilhá-la entre requisições concorrentes
   * faria duas apurações trabalharem sobre o mesmo objeto mutável.
   */
  orchestratorFor: (scope: EventScope) => Promise<FiscalOrchestratorService>;
  /**
   * Trilha operacional de autenticação, autorização e limite. Fica fora do event
   * log: aquele é prova fiscal, este é investigação de incidente.
   */
  securityTrail: SecurityTrail;
  /**
   * Ausente quando `ASAAS_API_KEY` não está configurada. A cobrança então roda
   * em modo "só cálculo": planos, calculadora e prévia de fatura funcionam, e
   * nada é enviado ao gateway. É o que permite operar as primeiras ondas sem
   * credencial de pagamento.
   */
  asaas?: AsaasGateway;
  /** Camada 3 do assistente. Ausente sem `ANTHROPIC_API_KEY`. */
  languageModel?: LanguageModelPort;
  /**
   * Coleta de DF-e. Ausente em dev: o banco é o de produção, e uma coleta em
   * homologação gravaria notas de teste na base real (ADR-006).
   */
  dfe?: DfeSyncService;
  /** O que o plano de cada regime inclui (`plans.features`). */
  planFeatures: PlanFeatures;
  /** Guarda cifrada e envio por e-mail do relatório do diagnóstico público. */
  readinessDelivery: ReadinessDelivery;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Coleta de DF-e, quando há gateway. Exposta para o `serve` e os testes
     * executarem a fila sem depender do worker de fundo.
     */
    dfeSync?: DfeSyncService;
  }
  interface FastifyRequest {
    /**
     * Preenchido pelo hook de autenticação. Sempre presente nas rotas
     * autenticadas, e as públicas não o leem.
     */
    tenant: TenantContext;
  }
}

/** Rotas sem autenticação. Tudo o mais exige token e associação a um escritório. */
export const PUBLIC_ROUTES = new Set([
  '/v1/auth/login',
  '/v1/health',
  // Preço público antes de qualquer contato comercial — ver briefing.
  '/v1/plans',
  '/v1/price-calculator',
  // Diagnóstico de prontidão para a reforma: o visitante sobe XMLs e vê o
  // tamanho do problema com os próprios dados, antes de qualquer cadastro.
  '/v1/reform-readiness',
  // O lead é anexado depois do relatório, e a tela que o envia também não tem
  // sessão. O id do diagnóstico é o que autoriza a escrita.
  '/v1/reform-readiness/lead',
  // O link "apagar meu e-mail" do relatório enviado: quem o abre não tem sessão,
  // e o token no link é o que autoriza.
  '/v1/reform-readiness/forget',
  /**
   * Páginas de metodologia. Nenhuma das duas lê `request.tenant`, e as duas
   * existem para ser lidas ANTES de contratar: a do simulador diz o que ele não
   * modela, e a do assistente diz o que ele sabe responder e que não há modelo
   * de linguagem configurado.
   *
   * Estavam atrás de autenticação por omissão — o hook global protege por
   * padrão, e a lista é o que abre. O efeito era uma página de venda que só
   * quem já é cliente conseguia ler.
   */
  '/v1/simulations/methodology',
  '/v1/assistant/capabilities',
  // Autenticado por token do gateway, não por JWT: o Asaas não tem sessão.
  '/v1/webhooks/asaas',
]);

export interface BuildServerOptions {
  env: Env;
  pool?: pg.Pool;
  /**
   * Gateway de cobrança. Os testes injetam um dublê; sem ele, o cliente HTTP é
   * montado a partir de `ASAAS_API_KEY`, e sem a chave não há gateway.
   */
  asaas?: AsaasGateway;
  /** Modelo de linguagem. Os testes injetam um dublê; sem ele, vem de `ANTHROPIC_API_KEY`. */
  languageModel?: LanguageModelPort;
  /** Envio de e-mail. Os testes injetam um dublê; sem ele, SMTP de `MAIL_SMTP_URL`. */
  mail?: MailGateway;
  /** Gateway da SEFAZ. Os testes injetam um dublê; sem ele, só em `prod`. */
  sefaz?: SefazDfeGateway;
  /**
   * Sobe o worker da coleta junto com o servidor. Só o `serve` liga: os testes
   * executam os jobs direto, e um worker de fundo disputaria a fila com eles.
   */
  startWorkers?: boolean;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { env } = options;
  let pool = options.pool;
  if (pool === undefined) {
    pool = new pg.Pool({ connectionString: env.databaseUrl });
    // Sem isto, o Supabase encerrar uma conexão ociosa derruba o servidor.
    // Só no pool que criamos: anexar a um pool injetado acumularia um listener
    // por `buildServer`, e os testes constroem vários sobre o mesmo pool.
    ignorarErroDeClienteOcioso(pool, 'ApiPool');
  }

  // O contrato de agentes é carregado uma vez, no start: relê-lo por requisição
  // seria I/O de disco no caminho quente, e ele não muda em runtime.
  const config = await loadConfig();
  const contractLoader = new ContractLoaderService();
  await contractLoader.loadAgentContract(config.contracts.agentContract);

  /**
   * A trilha usa `IP_HASH_SECRET` quando existe e, sem ela, deriva da chave do
   * cofre — mesma escada do diagnóstico público. O domínio do HMAC é outro, de
   * modo que os dois hashes não se cruzam por acidente.
   */
  const securityTrail = criarTrilhaDeSeguranca(
    pool,
    env.ipHashSecret ?? env.certificateMasterKey,
    (mensagem, dados) => new Logger('TrilhaDeSeguranca').error(mensagem, dados),
  );

  const deps: ApiDeps = {
    env,
    pool,
    securityTrail,
    jwtVerifier: new JwtVerifier(env),
    tenantResolver: new TenantResolver(pool),
    planFeatures: new PlanFeatures(pool),
    readinessDelivery: new ReadinessDelivery({
      pool,
      ...(env.reportEncryptionKey === undefined ? {} : { cipher: new ReadinessReportCipher(env.reportEncryptionKey) }),
      ...(options.mail !== undefined
        ? { mail: options.mail }
        : env.mail === undefined
          ? {}
          : { mail: new SmtpMailGateway(env.mail.smtpUrl, env.mail.from) }),
      ...(env.mail === undefined ? {} : { publicApiUrl: env.mail.publicApiUrl }),
    }),
    ...(options.asaas !== undefined
      ? { asaas: options.asaas }
      : env.asaas === undefined
        ? {}
        : { asaas: new AsaasClient({ apiKey: env.asaas.apiKey, baseUrl: env.asaas.baseUrl }) }),
    ...(options.languageModel !== undefined
      ? { languageModel: options.languageModel }
      : env.anthropic === undefined
        ? {}
        : {
            languageModel: new ClaudeLanguageModel({
              apiKey: env.anthropic.apiKey,
              model: env.anthropic.model,
            }),
          }),
    orchestratorFor: async (scope) => {
      const orchestrator = new FiscalOrchestratorService(
        new PostgresEventStoreRepository(pool, scope),
        contractLoader,
        scope,
      );
      await orchestrator.initialize();
      return orchestrator;
    },
  };

  const sefaz = options.sefaz ?? (env.environment === 'prod' ? new SefazSoapClient() : undefined);
  if (sefaz !== undefined) {
    deps.dfe = new DfeSyncService(
      pool,
      sefaz,
      env.certificateMasterKey,
      env.certificateMasterKeyPrevious,
      deps.orchestratorFor,
    );
  }

  const app = Fastify({
    /**
     * Atrás de proxy (Supabase, Fly, Cloudflare) `request.ip` é o IP do proxy, e
     * não o do visitante. Isso faria a quota do diagnóstico público virar um
     * balde único, bloqueando todo mundo depois dos primeiros acessos. Ligar sem
     * proxy na frente é pior — permitiria forjar o IP por cabeçalho —, então a
     * escolha é explícita por ambiente.
     */
    /**
     * Um id por requisição, que aparece em três lugares: em toda linha de log,
     * no cabeçalho `x-request-id` da resposta e na trilha de segurança.
     *
     * É o que liga a trilha ao log. Sem ele, a trilha dizia "403 em
     * /v1/clients" e não havia como achar a linha correspondente — nem o
     * cliente tinha um número para citar ao relatar um problema.
     *
     * Quando o proxy manda o seu, o dele vence: recusá-lo quebraria a
     * correlação justamente com quem está na frente. Mas ele é **higienizado**
     * antes de entrar, porque cabeçalho é campo livre e vai para dentro do log.
     */
    genReqId: (req) => idDaRequisicao(req.headers['x-request-id']),
    trustProxy: env.trustProxy,
    logger: {
      level: env.logLevel,
      // Authorization nunca entra no log: um token vazado em arquivo de log é um
      // token vazado.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  /**
   * A trilha usa `IP_HASH_SECRET` quando existe e, sem ela, deriva da chave do
   * cofre — mesma escada do diagnóstico público. O domínio do HMAC é outro, de
   * modo que os dois hashes não se cruzam por acidente.
   */
  /**
   * Devolve o id ao cliente. É o que permite alguém dizer "deu erro, o id é
   * este" — sem isso, o suporte começa pedindo o horário aproximado.
   */
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', String(request.id));
  });

  registerErrorHandler(app, deps.securityTrail);

  if (deps.dfe !== undefined) {
    app.decorate('dfeSync', deps.dfe);
  }

  if (options.startWorkers && deps.dfe !== undefined) {
    const worker = startDfeWorker(deps.dfe, {
      onError: (erro) => app.log.error({ err: erro }, 'worker da coleta de DF-e'),
    });
    const agendador = startDfeScheduler(deps.dfe, {
      onError: (erro) => app.log.error({ err: erro }, 'agendador da coleta de DF-e'),
    });
    app.addHook('onClose', async () => {
      await agendador.stop();
      await worker.stop();
    });
  }

  /**
   * Séries de índice (IPCA, INPC, IGP-M, TR, SELIC), uma vez por dia, só em
   * produção e com os workers: o dado é público e igual para todos, e dev
   * gravaria no mesmo banco o que prod já grava.
   */
  if (options.startWorkers && env.environment === 'prod') {
    const indices = startIndicesScheduler(pool, {
      onError: (erro) => app.log.error({ err: erro }, 'atualização das séries de índice'),
      onLoad: (relatorios) =>
        app.log.info(
          { indices: relatorios.map((r) => ({ id: r.indexId, ultimo: r.lastPeriod, conferida: r.verified })) },
          'séries de índice atualizadas',
        ),
    });
    app.addHook('onClose', async () => {
      await indices.stop();
    });
  }

  /**
   * Expurgo da trilha de segurança, uma vez por dia.
   *
   * Roda em qualquer ambiente, e não só em produção como o agendador de DF-e: a
   * trilha é escrita em todos, e deixar o desenvolvimento acumular meses de
   * rastro sem descarte contradiz a política que este mesmo expurgo aplica.
   */
  const expurgo = startSecurityTrailPruner(pool, {
    onError: (erro) => app.log.error({ err: erro }, 'expurgo da trilha de segurança'),
    onPurge: (apagadas) => app.log.info({ apagadas }, 'trilha de segurança expurgada'),
  });
  app.addHook('onClose', async () => {
    await expurgo.stop();
  });

  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
  });

  // Teto no multipart: sem ele o upload é vetor de carga. 5 MB por arquivo
  // cobre um A1 e um XML de NF-e com folga; 200 arquivos é o lote máximo de
  // ingestão, e acima disso o caminho previsto é o job assíncrono.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 200, fields: 8 },
  });

  /**
   * CSV como corpo cru, para a proposta do Fisco poder subir com um
   * `curl --data-binary @proposta.csv`. Guardado como string e não parseado
   * aqui: quem sabe interpretar o layout é o parser do módulo.
   */
  app.addContentTypeParser(
    ['text/csv', 'text/plain'],
    { parseAs: 'string', bodyLimit: 20 * 1024 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/v1/health', async () => ({ status: 'ok' }));

  /**
   * Limite das rotas autenticadas, por usuário do token.
   *
   * As rotas públicas já tinham limite; estas não tinham nenhum. Com token
   * válido dava para varrer `GET /clients/{cnpj}/…` no ritmo que a rede
   * aguentasse — e como cada chamada resolve escritório e consulta o banco, o
   * custo do abuso caía inteiro sobre o Postgres.
   *
   * A chave é o usuário, e não o IP: o IP de um escritório é compartilhado entre
   * os contadores dele, e limitar por IP puniria o escritório grande. O usuário
   * é quem o token identifica, e é quem responde pelo que fez.
   *
   * Os números são folgados de propósito. 240/min é bem mais do que uma tela
   * dispara ao abrir — o alvo é o laço automatizado, não o humano apressado.
   * Apertar isto sem medir transformaria o controle em chamado de suporte.
   *
   * **Em memória e por processo**, como o limitador das rotas públicas: com mais
   * de uma instância, cada uma conta a sua parte e o limite efetivo multiplica
   * pelo número de instâncias. Está registrado em `docs/seguranca/CONTROLES.md`.
   */
  const limitesAutenticados = [
    createBurstLimiter({ windowMs: 60_000, max: 240 }),
    createBurstLimiter({ windowMs: 3_600_000, max: 6_000 }),
  ];

  /**
   * Autenticação por hook global, não por rota: rota nova nasce protegida, e
   * esquecer de adicionar um `preHandler` não cria um vazamento silencioso. O
   * custo é manter `PUBLIC_ROUTES` explícito.
   */
  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) {
      return;
    }

    const user = await deps.jwtVerifier.verify(request.headers.authorization);

    // Antes de resolver o escritório, que é ida ao banco: sob abuso, o limite
    // deve custar menos que a requisição que ele recusa.
    exigirLimite(
      limitesAutenticados,
      [user.userId],
      'Muitas requisições. Espere e tente de novo.',
    );

    request.tenant = await deps.tenantResolver.resolve(user);
  });

  // Depois da autenticação e da validação: recusa o que o plano do CNPJ não inclui.
  registerPlanGate(app, deps.pool, deps.planFeatures);

  await app.register(
    async (instance) => {
      await registerAuthRoutes(instance, deps);
      await registerPortfolioRoutes(instance, deps);
      await registerEventRoutes(instance, deps);
      await registerCertificateRoutes(instance, deps);
      await registerBillingRoutes(instance, deps);
      await registerBillingWebhook(instance, deps);
      await registerIngestionRoutes(instance, deps);
      await registerPublicRoutes(instance, deps);
      await registerCatalogRoutes(instance, deps);
      await registerAssessmentRoutes(instance, deps);
      await registerReportingRoutes(instance, deps);
      await registerReconciliationRoutes(instance, deps);
      await registerAssistantRoutes(instance, deps);
      await registerCreditRoutes(instance, deps);
    await registerAuditRoutes(instance, deps);
    await registerIndicesRoutes(instance, deps);
      await registerSimulationRoutes(instance, deps);
      await registerDossierRoutes(instance, deps);
      await registerEfdIcmsIpiRoutes(instance, deps);
    },
    { prefix: '/v1' },
  );

  app.addHook('onClose', async () => {
    if (!options.pool) {
      await pool.end();
    }
  });

  return app;
}

/**
 * Id da requisição, do proxy ou nosso.
 *
 * O cabeçalho vem de fora e acaba dentro do log, então passa por filtro: só
 * alfanumérico, hífen e sublinhado, no máximo 64 caracteres. Sem isso, uma
 * quebra de linha no cabeçalho escreveria uma linha falsa no log — e log
 * adulterável não serve de evidência.
 */
function idDaRequisicao(bruto: string | string[] | undefined): string {
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  const limpo = (valor ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');

  return limpo.length > 0 ? limpo.slice(0, 64) : randomUUID();
}
