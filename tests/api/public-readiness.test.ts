import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { nfeXml } from '../helpers/nfe-xml.js';
import { randomCnpj } from '../helpers/db.js';
import { createHmac } from 'node:crypto';
import { extractPdfText } from '../helpers/pdf.js';
import type { MailGateway, MailMessage } from '../../src/infrastructure/mail/mail-gateway.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const MASTER_KEY = 'chave-mestra-de-teste-com-mais-de-32-caracteres';

const EMITENTE = '11222333000181';
const DESTINATARIO = '99999999000191';

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    AUDIT_ENV: 'dev',
    DATABASE_URL,
    SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
    SUPABASE_ANON_KEY: 'chave-anon-de-teste',
    SUPABASE_JWT_SECRET: JWT_SECRET,
    SUPABASE_JWT_AUDIENCE: 'authenticated',
    CERTIFICATE_MASTER_KEY: MASTER_KEY,
    LOG_LEVEL: 'silent',
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe.skipIf(!DATABASE_URL)('API — diagnóstico público de prontidão', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  /**
   * Cada teste precisa de um IP próprio: a rajada é 3/min por IP, e reusar o
   * mesmo IP faria um teste derrubar o seguinte.
   */
  let contadorDeIp = 0;
  const proximoIp = (): string => {
    contadorDeIp += 1;
    return `10.${Math.floor(contadorDeIp / 250)}.0.${(contadorDeIp % 250) + 1}`;
  };

  const diagnosticar = async (
    arquivos: { nome: string; conteudo: string }[],
    opcoes: { ip?: string; campos?: Record<string, string>; servidor?: FastifyInstance } = {},
  ) => {
    const form = new FormData();
    for (const arquivo of arquivos) {
      form.append('files', Buffer.from(arquivo.conteudo, 'utf8'), { filename: arquivo.nome });
    }
    for (const [chave, valor] of Object.entries(opcoes.campos ?? {})) {
      form.append(chave, valor);
    }

    return (opcoes.servidor ?? app).inject({
      method: 'POST',
      url: '/v1/reform-readiness',
      headers: { ...form.getHeaders(), 'x-forwarded-for': opcoes.ip ?? proximoIp() },
      remoteAddress: opcoes.ip ?? proximoIp(),
      payload: form,
    });
  };

  const nota = (numero: string, comReforma = false) => ({
    nome: `${numero}.xml`,
    conteudo: nfeXml({
      issuer: EMITENTE,
      recipient: DESTINATARIO,
      numero,
      withReform: comReforma,
    }),
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    app = await buildServer({ env: loadEnv(baseEnv({ TRUST_PROXY: 'true' })), pool });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('delete from readiness_reports');
  });

  describe('acesso', () => {
    it('responde sem cabeçalho de autenticação', async () => {
      const response = await diagnosticar([nota('000000001', true)]);

      expect(response.statusCode).toBe(200);
      expect(response.json().documents_ready.ready_pct).toBe(100);
    });

    /**
     * A rota é pública: o hook global nem tenta verificar o token. Um Bearer
     * inválido não pode virar 401 aqui, senão um visitante com sessão velha no
     * navegador não conseguiria usar o diagnóstico.
     */
    it('ignora token inválido em vez de responder 401', async () => {
      const form = new FormData();
      form.append('files', Buffer.from(nfeXml({ issuer: EMITENTE, recipient: DESTINATARIO }), 'utf8'), {
        filename: 'nota.xml',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/reform-readiness',
        headers: {
          ...form.getHeaders(),
          authorization: 'Bearer isto-nao-e-um-token',
          'x-forwarded-for': proximoIp(),
        },
        payload: form,
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('relatório', () => {
    it('devolve os três recortes de prontidão', async () => {
      const response = await diagnosticar([
        nota('000000001', true),
        nota('000000002'),
        nota('000000003'),
        nota('000000004'),
      ]);

      const body = response.json();
      expect(body.documents_ready).toMatchObject({ total: 4, ready: 1, ready_pct: 25 });
      expect(body.items_ready.total).toBe(4);
      expect(body.value_ready.ready_pct).toBe(25);
      expect(body.issuers[0]).toMatchObject({ cnpj: EMITENTE });
    });

    it('um XML inválido vira achado do diagnóstico, não erro da requisição', async () => {
      const response = await diagnosticar([
        nota('000000001', true),
        { nome: 'quebrado.xml', conteudo: '<nao-e-uma-nota/>' },
      ]);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.totals).toMatchObject({ documents: 2, parsed: 1, rejected: 1 });
      expect(body.rejections[0].filename).toBe('quebrado.xml');
    });

    it('anuncia na resposta que nada foi persistido', async () => {
      const body = (await diagnosticar([nota('000000001')])).json();

      // Sem REPORT_ENCRYPTION_KEY nada fica guardado, nem o resumo.
      expect(body.persisted).toEqual({ documents: false, summary_until: null });
      expect(body.lead_registered).toBe(false);
      expect(body.limits.max_files).toBe(50);
    });
  });

  describe('não persistência', () => {
    /**
     * A promessa central da rota. Se um documento de visitante anônimo entrasse
     * em `documents`, ele ficaria sem dono, sem RLS e sem base legal.
     */
    it('não grava documento, item nem evento — só a métrica agregada', async () => {
      // Emitente exclusivo deste teste: contar linhas globais seria frágil,
      // porque os arquivos de teste rodam em paralelo sobre o mesmo schema.
      const emitente = randomCnpj();
      const xml = nfeXml({ issuer: emitente, recipient: DESTINATARIO, withReform: true });

      await diagnosticar([{ nome: 'nota.xml', conteudo: xml }]);

      const documentos = await pool.query(
        'select count(*) from documents where issuer_cnpj = $1',
        [emitente],
      );
      const itens = await pool.query(
        `select count(*) from document_items di
          where exists (select 1 from documents d
                         where d.access_key = di.access_key and d.issuer_cnpj = $1)`,
        [emitente],
      );
      const eventos = await pool.query(
        `select count(*) from events where payload::text like '%' || $1 || '%'`,
        [emitente],
      );

      expect(Number(documentos.rows[0].count)).toBe(0);
      expect(Number(itens.rows[0].count)).toBe(0);
      expect(Number(eventos.rows[0].count)).toBe(0);

      const metrica = await pool.query('select * from readiness_reports');
      expect(metrica.rows).toHaveLength(1);
      expect(metrica.rows[0]).toMatchObject({
        documents_total: 1,
        documents_parsed: 1,
        documents_with_reform: 1,
      });
    });

    it('guarda o IP como hash, nunca em claro', async () => {
      const ip = '203.0.113.42';
      await diagnosticar([nota('000000001')], { ip });

      const { rows } = await pool.query('select * from readiness_reports');
      expect(rows[0].ip_hash).toHaveLength(64);
      expect(JSON.stringify(rows[0])).not.toContain(ip);
    });

    it('a métrica não guarda CNPJ, chave de acesso nem razão social', async () => {
      await diagnosticar([nota('000000001', true)]);

      const { rows } = await pool.query('select * from readiness_reports');
      const linha = JSON.stringify(rows[0]);

      expect(linha).not.toContain(EMITENTE);
      expect(linha).not.toMatch(/[0-9]{44}/);
      expect(linha).not.toContain('EMITENTE LTDA');
    });
  });

  describe('captura de e-mail', () => {
    it('sem consentimento não grava lead, e ainda assim entrega o relatório', async () => {
      const response = await diagnosticar([nota('000000001')], {
        campos: { email: 'contador@escritorio.com.br' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lead_registered).toBe(false);

      const { rows } = await pool.query('select email, email_consent_at from readiness_reports');
      expect(rows[0].email).toBeNull();
    });

    it('com consentimento grava o lead e carimba a data', async () => {
      const response = await diagnosticar([nota('000000001')], {
        campos: { email: 'contador@escritorio.com.br', consent: 'true', source: 'landing' },
      });

      expect(response.json().lead_registered).toBe(true);

      const { rows } = await pool.query(
        'select email, email_consent_at, source from readiness_reports',
      );
      expect(rows[0].email).toBe('contador@escritorio.com.br');
      expect(rows[0].email_consent_at).not.toBeNull();
      expect(rows[0].source).toBe('landing');
    });

    /** Endereço malformado não justifica gastar CPU com 50 parses. */
    it('recusa e-mail malformado antes de processar o lote', async () => {
      const response = await diagnosticar([nota('000000001')], {
        campos: { email: 'isto-nao-e-email', consent: 'true' },
      });

      expect(response.statusCode).toBe(400);
      // Frase pronta, sem o vocabulário do pipeline: quem lê é um visitante.
      expect(response.json().message).toBe('E-mail inválido.');
      expect(response.json().message).not.toMatch(/layer|schema_violation/);
      const { rows } = await pool.query('select count(*) from readiness_reports');
      expect(Number(rows[0].count)).toBe(0);
    });
  });

  describe('lead depois do relatório', () => {
    /**
     * A tela mostra o relatório primeiro e só então oferece o envio por e-mail.
     * Sem rota própria, registrar o endereço obrigava a reenviar os mesmos XMLs
     * — parsing duplicado e uma segunda linha de métrica para o mesmo
     * diagnóstico.
     */
    const registrar = async (body: Record<string, unknown>, ip = proximoIp()) =>
      app.inject({
        method: 'POST',
        url: '/v1/reform-readiness/lead',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        payload: body,
      });

    it('anexa o e-mail ao diagnóstico já feito, sem reprocessar nada', async () => {
      const diagnostico = (await diagnosticar([nota('000000001', true)])).json();
      expect(diagnostico.report_id).toMatch(/^[0-9a-f-]{36}$/);

      const r = await registrar({
        report_id: diagnostico.report_id,
        email: 'contador@escritorio.com.br',
        consent: true,
        source: 'landing',
      });

      expect(r.statusCode).toBe(200);
      expect(r.json().lead_registered).toBe(true);

      // Uma linha só: o lead entrou na métrica que já existia.
      const { rows } = await pool.query('select email, email_consent_at, source from readiness_reports');
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('contador@escritorio.com.br');
      expect(rows[0].email_consent_at).not.toBeNull();
      expect(rows[0].source).toBe('landing');
    });

    it('recusa sem consentimento', async () => {
      const diagnostico = (await diagnosticar([nota('000000001')])).json();

      const r = await registrar({
        report_id: diagnostico.report_id,
        email: 'contador@escritorio.com.br',
        consent: false,
      });

      expect(r.statusCode).toBe(400);
      expect(r.json().message).toMatch(/consentir/);
      const { rows } = await pool.query('select email from readiness_reports');
      expect(rows[0].email).toBeNull();
    });

    it('recusa e-mail malformado', async () => {
      const diagnostico = (await diagnosticar([nota('000000001')])).json();

      const r = await registrar({
        report_id: diagnostico.report_id,
        email: 'isto-nao-e-email',
        consent: true,
      });

      expect(r.statusCode).toBe(400);
      expect(r.json().message).toBe('E-mail inválido.');
    });

    /** Reenviar o formulário não pode trocar o endereço nem a data já consentida. */
    it('não sobrescreve lead já registrado', async () => {
      const diagnostico = (await diagnosticar([nota('000000001')])).json();

      await registrar({ report_id: diagnostico.report_id, email: 'primeiro@x.com', consent: true });
      const segunda = await registrar({
        report_id: diagnostico.report_id,
        email: 'segundo@x.com',
        consent: true,
      });

      expect(segunda.statusCode).toBe(404);
      const { rows } = await pool.query('select email from readiness_reports');
      expect(rows[0].email).toBe('primeiro@x.com');
    });

    /**
     * 404 tanto para id inexistente quanto para diagnóstico que já tem lead:
     * distinguir confirmaria a existência de um id a quem está chutando.
     */
    it('404 para diagnóstico inexistente', async () => {
      const r = await registrar({
        report_id: '00000000-0000-4000-8000-000000000000',
        email: 'a@b.com',
        consent: true,
      });

      expect(r.statusCode).toBe(404);
    });

    it('recusa id que não é UUID', async () => {
      const r = await registrar({ report_id: 'nao-e-uuid', email: 'a@b.com', consent: true });

      expect(r.statusCode).toBe(400);
    });

    it('dispensa autenticação, como o diagnóstico', async () => {
      const diagnostico = (await diagnosticar([nota('000000001')])).json();

      const r = await app.inject({
        method: 'POST',
        url: '/v1/reform-readiness/lead',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer isto-nao-e-um-token',
          'x-forwarded-for': proximoIp(),
        },
        payload: { report_id: diagnostico.report_id, email: 'a@b.com', consent: true },
      });

      expect(r.statusCode).toBe(200);
    });
  });

  describe('limites', () => {
    it('recusa lote vazio', async () => {
      const form = new FormData();
      form.append('vazio', 'sem arquivo');
      const response = await app.inject({
        method: 'POST',
        url: '/v1/reform-readiness',
        headers: { ...form.getHeaders(), 'x-forwarded-for': proximoIp() },
        payload: form,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('Nenhum arquivo XML enviado.');
    });

    it('recusa mais de 50 arquivos', async () => {
      const arquivos = Array.from({ length: 51 }, (_, i) =>
        nota(String(i + 1).padStart(9, '0')),
      );
      const response = await diagnosticar(arquivos);

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('Máximo de 50 arquivos por requisição.');
      expect(response.json().message).not.toMatch(/layer|schema_violation/);
    });

    /**
     * Dois 429 com significados opostos convivem na API: este é `rate_limited`,
     * e o de limite de plano é outro. A tela bifurca por `code`, não por status.
     */
    it('a quarta chamada seguida do mesmo IP é barrada com rate_limited', async () => {
      const ip = '198.51.100.7';
      for (let i = 0; i < 3; i += 1) {
        const ok = await diagnosticar([nota(String(i + 1).padStart(9, '0'))], { ip });
        expect(ok.statusCode).toBe(200);
      }

      const barrada = await diagnosticar([nota('000000004')], { ip });

      expect(barrada.statusCode).toBe(429);
      expect(barrada.json().code).toBe('rate_limited');
      expect(barrada.json().retry_after_seconds).toBeGreaterThan(0);
      expect(barrada.headers['retry-after']).toBeDefined();
    });

    it('a quota diária barra mesmo sem rajada', async () => {
      const ip = '198.51.100.99';
      // Semeia 20 diagnósticos do mesmo IP direto na métrica, sem passar pela
      // rajada — é o cenário de quem volta ao longo do dia.
      const { rows } = await pool.query(
        `insert into readiness_reports (ip_hash) values (encode(sha256('x'::bytea), 'hex'))
         returning ip_hash`,
      );
      await pool.query('delete from readiness_reports');

      expect(rows[0].ip_hash).toHaveLength(64);

      // Descobre o hash real daquele IP fazendo uma chamada legítima.
      await diagnosticar([nota('000000001')], { ip });
      const { rows: primeira } = await pool.query('select ip_hash from readiness_reports');
      const ipHash = primeira[0].ip_hash;

      for (let i = 0; i < 19; i += 1) {
        await pool.query('insert into readiness_reports (ip_hash) values ($1::char(64))', [ipHash]);
      }

      const barrada = await diagnosticar([nota('000000002')], { ip });
      expect(barrada.statusCode).toBe(429);
      expect(barrada.json().message).toMatch(/por dia/);
    });
  });

  describe('relatório por e-mail', () => {
    const IP_SECRET = 'segredo-do-hmac-do-ip-com-mais-de-32-caracteres';
    let comEnvio: FastifyInstance;
    let enviados: MailMessage[];
    let falhar: boolean;

    const dublê: MailGateway = {
      async send(message) {
        if (falhar) throw new Error('SMTP recusou: 550');
        enviados.push(message);
        return { messageId: `<${enviados.length}@teste>` };
      },
    };

    const lead = async (reportId: string, ip = proximoIp()) =>
      comEnvio.inject({
        method: 'POST',
        url: '/v1/reform-readiness/lead',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        payload: { report_id: reportId, email: 'contador@escritorio.com.br', consent: true },
      });

    const linha = async (id: string) =>
      (
        await pool.query(
          `select email, email_consent_at, email_sent_at, email_error, report_ciphertext,
                  report_expires_at, forget_token_hash, ip_hash
             from readiness_reports where id = $1::uuid`,
          [id],
        )
      ).rows[0];

    beforeAll(async () => {
      comEnvio = await buildServer({
        env: loadEnv(
          baseEnv({
            TRUST_PROXY: 'true',
            REPORT_ENCRYPTION_KEY: 'chave-do-relatorio-de-teste-com-mais-de-32',
            IP_HASH_SECRET: IP_SECRET,
            MAIL_SMTP_URL: 'smtp://usuario:senha@smtp.exemplo.com.br:587',
            MAIL_FROM: 'Diagnóstico <diagnostico@exemplo.com.br>',
            PUBLIC_API_URL: 'https://api.exemplo.com.br/',
          }),
        ),
        pool,
        mail: dublê,
      });
      await comEnvio.ready();
    });

    afterAll(async () => {
      await comEnvio?.close();
    });

    beforeEach(() => {
      enviados = [];
      falhar = false;
    });

    it('guarda o resumo cifrado por 24h, sem CNPJ nem razão social em claro', async () => {
      const body = (await diagnosticar([nota('000000001', true)], { servidor: comEnvio })).json();

      const ate = new Date(body.persisted.summary_until).getTime();
      expect(body.persisted.documents).toBe(false);
      expect(ate - Date.now()).toBeGreaterThan(23.9 * 3600_000);
      expect(ate - Date.now()).toBeLessThanOrEqual(24 * 3600_000);

      const r = await linha(body.report_id);
      expect(r.report_ciphertext).not.toBeNull();
      expect(r.report_ciphertext).not.toContain(EMITENTE);
      expect(r.report_ciphertext).not.toContain('11.222.333');
    });

    it('o lead recebe o PDF, com o link de remoção, e o resumo é apagado', async () => {
      const { report_id } = (await diagnosticar([nota('000000001', true)], { servidor: comEnvio })).json();

      const r = await lead(report_id);

      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ lead_registered: true, email_sent: true });
      expect(enviados).toHaveLength(1);
      expect(enviados[0]!.to).toBe('contador@escritorio.com.br');
      expect(enviados[0]!.text).toMatch(/https:\/\/api\.exemplo\.com\.br\/v1\/reform-readiness\/forget\?token=[\w-]{40,}/);
      const pdf = enviados[0]!.attachments![0]!;
      expect(pdf.contentType).toBe('application/pdf');
      expect(extractPdfText(pdf.content)).toMatch(/prontidão/);

      const depois = await linha(report_id);
      expect(depois.report_ciphertext).toBeNull();
      expect(depois.email_sent_at).not.toBeNull();
      expect(depois.forget_token_hash).toHaveLength(64);
    });

    it('com e-mail e consentimento no próprio diagnóstico, envia na hora', async () => {
      const body = (
        await diagnosticar([nota('000000001')], {
          servidor: comEnvio,
          campos: { email: 'contador@escritorio.com.br', consent: 'true' },
        })
      ).json();

      expect(body).toMatchObject({ lead_registered: true, email_sent: true });
      expect(enviados).toHaveLength(1);
    });

    it('o link de remoção apaga o e-mail e o consentimento, e só vale uma vez', async () => {
      const { report_id } = (await diagnosticar([nota('000000001')], { servidor: comEnvio })).json();
      await lead(report_id);
      const link = /forget\?token=([\w-]+)/.exec(enviados[0]!.text)![1]!;

      const r = await comEnvio.inject({ method: 'GET', url: `/v1/reform-readiness/forget?token=${link}`, remoteAddress: proximoIp() });

      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.body).toMatch(/apagado/);
      const depois = await linha(report_id);
      expect(depois.email).toBeNull();
      expect(depois.email_consent_at).toBeNull();
      expect(depois.forget_token_hash).toBeNull();

      const deNovo = await comEnvio.inject({ method: 'GET', url: `/v1/reform-readiness/forget?token=${link}`, remoteAddress: proximoIp() });
      expect(deNovo.statusCode).toBe(404);
    });

    it('relatório vencido é 410, e o e-mail não é gravado', async () => {
      const { report_id } = (await diagnosticar([nota('000000001')], { servidor: comEnvio })).json();
      await pool.query(
        "update readiness_reports set report_expires_at = now() - interval '1 minute' where id = $1::uuid",
        [report_id],
      );

      const r = await lead(report_id);

      expect(r.statusCode).toBe(410);
      expect(r.json().code).toBe('report_expired');
      const depois = await linha(report_id);
      expect(depois.email).toBeNull();
      // A purga já passou por ele.
      expect(depois.report_ciphertext).toBeNull();
    });

    it('falha do SMTP grava o motivo, e o lead continua registrado', async () => {
      const { report_id } = (await diagnosticar([nota('000000001')], { servidor: comEnvio })).json();
      falhar = true;

      const r = await lead(report_id);

      expect(r.json()).toEqual({ lead_registered: true, email_sent: false, email_not_sent_reason: 'send_failed' });
      const depois = await linha(report_id);
      expect(depois.email).toBe('contador@escritorio.com.br');
      expect(depois.email_error).toMatch(/550/);
    });

    it('sem SMTP configurado, grava o lead e diz que o e-mail não saiu', async () => {
      const { report_id } = (await diagnosticar([nota('000000001')])).json();

      const r = await app.inject({
        method: 'POST',
        url: '/v1/reform-readiness/lead',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': proximoIp() },
        payload: { report_id, email: 'contador@escritorio.com.br', consent: true },
      });

      expect(r.json()).toEqual({
        lead_registered: true,
        email_sent: false,
        email_not_sent_reason: 'mail_not_configured',
      });
    });

    it('o hash do IP é HMAC com IP_HASH_SECRET, desacoplado da chave do cofre', async () => {
      const ip = '203.0.113.7';
      const { report_id } = (await diagnosticar([nota('000000001')], { servidor: comEnvio, ip })).json();

      const esperado = createHmac('sha256', IP_SECRET).update(`public-diagnostic-ip:${ip}`).digest('hex');
      expect((await linha(report_id)).ip_hash).toBe(esperado);
    });

    /** Antes, requisições simultâneas passavam todas pela contagem antes de alguma gravar. */
    it('a quota não é furada por requisições simultâneas', async () => {
      const ip = '203.0.113.8';
      const { report_id } = (await diagnosticar([nota('000000001')], { servidor: comEnvio, ip })).json();
      const { ip_hash } = await linha(report_id);
      for (let i = 0; i < 18; i += 1) {
        await pool.query('insert into readiness_reports (ip_hash) values ($1::char(64))', [ip_hash]);
      }

      // 19 usadas: das duas simultâneas, exatamente uma cabe.
      const respostas = await Promise.all([
        diagnosticar([nota('000000002')], { servidor: comEnvio, ip }),
        diagnosticar([nota('000000003')], { servidor: comEnvio, ip }),
      ]);

      expect(respostas.map((r) => r.statusCode).sort()).toEqual([200, 429]);
      const { rows } = await pool.query('select count(*)::int n from readiness_reports where ip_hash = $1', [ip_hash]);
      expect(rows[0].n).toBe(20);
    });
  });

  describe('killswitch', () => {
    it('desligado, responde 503 sem tocar no lote', async () => {
      const desligado = await buildServer({
        env: loadEnv(baseEnv({ TRUST_PROXY: 'true', PUBLIC_DIAGNOSTIC_ENABLED: 'false' })),
        pool,
      });
      await desligado.ready();

      try {
        const form = new FormData();
        form.append('files', Buffer.from(nfeXml({ issuer: EMITENTE, recipient: DESTINATARIO }), 'utf8'), {
          filename: 'nota.xml',
        });
        const response = await desligado.inject({
          method: 'POST',
          url: '/v1/reform-readiness',
          headers: { ...form.getHeaders() },
          payload: form,
        });

        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('diagnostic_disabled');
      } finally {
        await desligado.close();
      }
    });
  });
});
