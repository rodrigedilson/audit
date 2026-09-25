import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import type { CapagExtractorPort } from '../../src/fiscal/forensics/capag/capag-extractor.port.js';
import type { CapagExtraction } from '../../src/fiscal/forensics/capag/capag-extraction.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { DEMONSTRATIVO_LINHAS, extracaoDoDemonstrativo, pdfDoDemonstrativo } from '../helpers/capag.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

/** Extrator dublado: devolve a extração que o teste montou, e registra o texto que recebeu. */
class ExtratorDublado implements CapagExtractorPort {
  readonly name = 'dublê';
  textos: string[] = [];
  resposta: CapagExtraction = extracaoDoDemonstrativo();
  async extract(input: { text: string }): Promise<CapagExtraction> {
    this.textos.push(input.text);
    return structuredClone(this.resposta);
  }
}

describe.skipIf(!DATABASE_URL)('API — CAPAG presumida', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let semExtrator: FastifyInstance;
  const extrator = new ExtratorDublado();
  let tenantId: string;
  let owner: string;
  let cnpj: string;

  const token = async (userId: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const enviar = async (arquivo: Buffer, servidor = app, userId = owner) => {
    const form = new FormData();
    form.append('file', arquivo, { filename: 'capag.pdf', contentType: 'application/pdf' });
    return servidor.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/capag/statements`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await token(userId)}` },
      payload: form,
    });
  };
  const ler = async () =>
    app.inject({ method: 'GET', url: `/v1/clients/${cnpj}/capag`, headers: { authorization: `Bearer ${await token(owner)}` } });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const env = loadEnv({
      AUDIT_ENV: 'dev',
      DATABASE_URL,
      SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
      SUPABASE_ANON_KEY: 'chave-anon-de-teste',
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_JWT_AUDIENCE: AUDIENCE,
      CERTIFICATE_MASTER_KEY: 'chave-mestra-de-teste-com-mais-de-32-caracteres',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    app = await buildServer({ env, pool, capagExtractor: extrator });
    semExtrator = await buildServer({ env, pool });
    await Promise.all([app.ready(), semExtrator.ready()]);
  });

  afterAll(async () => {
    await app?.close();
    await semExtrator?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    tenantId = await createTenant(pool, 'Escritório da CAPAG');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    extrator.textos = [];
    extrator.resposta = extracaoDoDemonstrativo();
  });

  it('demonstrativo que reproduz: conferido, com os valores lidos pelo código', async () => {
    const r = await enviar(await pdfDoDemonstrativo());

    expect(r.statusCode, r.body).toBe(201);
    const s = r.json().statement;
    expect(s).toMatchObject({
      verified: true,
      reproduces: true,
      problems: [],
      printed_capag_cents: 95_000_000,
      computed_capag_cents: 95_000_000,
      total_debt_cents: 200_000_000,
      printed_band: 'C',
      reference_date: '2026-08-01',
      group: 'pj_nao_simples',
      document_kind: 'pdf',
      values_cents: { V1: 100_000_000, V7: 20_000_000, V8: 5_000_000 },
    });
    expect(s.document_sha256).toMatch(/^[0-9a-f]{64}$/);
    // O modelo leu o texto extraído do PDF, que é o mesmo que a conferência usa.
    expect(extrator.textos[0]).toContain('Capacidade de pagamento presumida: R$ 950.000,00');
  });

  it('o evento vai para o log, e a projeção continua íntegra', async () => {
    await enviar(await pdfDoDemonstrativo());

    const { rows } = await pool.query(
      "select actor, payload from events where tenant_id = $1::uuid and cnpj = $2 and action = 'capag.statement_imported'",
      [tenantId, cnpj],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(owner);
    expect(rows[0].payload).toMatchObject({ verified: true, reproduces: true });
    const verify = await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/verify`,
      headers: { authorization: `Bearer ${await token(owner)}` },
    });
    expect(verify.json().ok).toBe(true);
  });

  it('valor que o modelo transcreveu errado: gravado, não conferido, com o problema', async () => {
    extrator.resposta.values[0]!.amount.printed = 'R$ 10.000.000,00';

    const s = (await enviar(await pdfDoDemonstrativo())).json().statement;

    expect(s.verified).toBe(false);
    expect(s.problems).toContainEqual(expect.stringMatching(/não está no trecho citado/));
    expect((await ler()).json().statement.statement_id).toBe(s.statement_id);
  });

  it('documento que não é demonstrativo: não conferido, e diz por quê', async () => {
    extrator.resposta.documentKind = 'outro';

    const s = (await enviar(await pdfDoDemonstrativo())).json().statement;

    expect(s.verified).toBe(false);
    expect(s.problems[0]).toMatch(/não parece um demonstrativo/);
  });

  it('PDF sem texto é 400 com o que fazer, sem chamar o modelo', async () => {
    const r = await enviar(await pdfDoDemonstrativo(['']));

    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/digitalizado/);
    expect(extrator.textos).toHaveLength(0);
  });

  it('sem ANTHROPIC_API_KEY, 503 dizendo por quê', async () => {
    const r = await enviar(await pdfDoDemonstrativo(), semExtrator);

    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('capag_extractor_not_configured');
  });

  it('viewer não envia demonstrativo', async () => {
    const viewer = await createMembership(pool, tenantId, 'viewer');
    expect((await enviar(await pdfDoDemonstrativo(), app, viewer)).statusCode).toBe(403);
  });

  it('dez por hora por escritório: o décimo primeiro é 429', async () => {
    const arquivo = await pdfDoDemonstrativo();
    for (let i = 0; i < 10; i += 1) {
      expect((await enviar(arquivo)).statusCode).toBe(201);
    }
    const r = await enviar(arquivo);
    expect(r.statusCode).toBe(429);
  });

  it('GET traz o último demonstrativo e a fórmula de referência de doutrina, não conferida', async () => {
    await pool.query(
      `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, legal_basis, model)
       values ('pj_nao_simples', 5, '[]'::jsonb, '[{"url":"https://exemplo.com.br/capag","quotes":["5 x (0,10 V1"]}]'::jsonb, 'doutrina', 'teste')`,
    );
    await enviar(await pdfDoDemonstrativo());

    const corpo = (await ler()).json();

    expect(corpo.extractor_configured).toBe(true);
    expect(corpo.statement.verified).toBe(true);
    expect(corpo.reference_formulas.find((f: { group: string }) => f.group === 'pj_nao_simples')).toMatchObject({
      income_multiplier: 5,
      source_kind: 'doutrina',
      verified: false,
    });
  });

  it('só a referência oficial da PGFN pode ser conferida, nem por SQL a de doutrina', async () => {
    const fonte = '[{"url":"https://www.gov.br/pgfn/x","quotes":["5(0.3V1"]}]';
    await expect(
      pool.query(
        `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, model, verified)
         values ('mei', 1, '[]'::jsonb, $1::jsonb, 'teste', true)`,
        [fonte],
      ),
    ).rejects.toThrow(/capag_referencia_conferida_so_oficial/);
    await expect(
      pool.query(
        `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, model, source_kind, verified)
         values ('mei', 1, '[]'::jsonb, '[]'::jsonb, 'teste', 'oficial_pgfn', true)`,
      ),
    ).rejects.toThrow(/capag_referencia_conferida_so_oficial/);
    await pool.query(
      `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, model, source_kind, verified)
       values ('mei', 1, '[]'::jsonb, $1::jsonb, 'teste', 'oficial_pgfn', true)`,
      [fonte],
    );
  });

  it('GET prefere a fórmula oficial conferida à de doutrina mais recente', async () => {
    await pool.query(
      `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, model, source_kind, verified, extracted_at)
       values ('pessoa_fisica', 5, '[]'::jsonb, '[{"url":"https://www.gov.br/pgfn/x","quotes":["5(0.3V1"]}]'::jsonb,
               'teste', 'oficial_pgfn', true, now() - interval '1 day')`,
    );
    await pool.query(
      `insert into capag_reference_formulas (capag_group, income_multiplier, terms, sources, model)
       values ('pessoa_fisica', 4, '[]'::jsonb, '[{"url":"https://exemplo.com.br/capag","quotes":["4 x"]}]'::jsonb, 'teste')`,
    );

    const corpo = (await ler()).json();

    expect(corpo.reference_formulas.find((f: { group: string }) => f.group === 'pessoa_fisica')).toMatchObject({
      income_multiplier: 5,
      source_kind: 'oficial_pgfn',
      verified: true,
    });
  });

  it('o linha do demonstrativo não guarda o arquivo, só o extraído', async () => {
    await enviar(await pdfDoDemonstrativo());
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_name = 'capag_statements' and data_type = 'bytea'",
    );
    expect(rows).toEqual([]);
    expect(DEMONSTRATIVO_LINHAS.length).toBeGreaterThan(0);
  });
});
