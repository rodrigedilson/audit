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
import { registerSimulationRoutes } from './routes/simulation.routes.js';
import { registerDossierRoutes } from './routes/dossier.routes.js';
import { registerEfdIcmsIpiRoutes } from './routes/efd-icms-ipi.routes.js';
import { AsaasClient, type AsaasGateway } from '../billing/asaas-client.js';
import type { LanguageModelPort } from '../fiscal/assistant/language-model.port.js';
import { ClaudeLanguageModel } from '../fiscal/assistant/claude-language-model.js';
import { SefazSoapClient, type SefazDfeGateway } from '../fiscal/dfe/sefaz-gateway.js';
import { DfeSyncService } from '../fiscal/dfe/dfe-sync.service.js';
import { startDfeScheduler, startDfeWorker } from '../fiscal/dfe/dfe-worker.js';
import { FiscalOrchestratorService } from '../esaa/orchestrator/fiscal-orchestrator.service.js';
import { ContractLoaderService } from '../esaa/core/contracts/contract-loader.service.js';
import { PostgresEventStoreRepository } from '../infrastructure/persistence/postgres-event-store.repository.js';
import type { EventScope } from '../esaa/core/event-store/value-objects/event-scope.vo.js';
import { loadConfig } from '../config/esaa-config.js';

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

  const deps: ApiDeps = {
    env,
    pool,
    jwtVerifier: new JwtVerifier(env),
    tenantResolver: new TenantResolver(pool),
    planFeatures: new PlanFeatures(pool),
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
    trustProxy: env.trustProxy,
    logger: {
      level: env.logLevel,
      // Authorization nunca entra no log: um token vazado em arquivo de log é um
      // token vazado.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  registerErrorHandler(app);

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
   * Autenticação por hook global, não por rota: rota nova nasce protegida, e
   * esquecer de adicionar um `preHandler` não cria um vazamento silencioso. O
   * custo é manter `PUBLIC_ROUTES` explícito.
   */
  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) {
      return;
    }

    const user = await deps.jwtVerifier.verify(request.headers.authorization);
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
