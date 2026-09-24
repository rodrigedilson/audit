import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import type {
  LanguageModelPort,
  ModelAnswer,
  ModelRequest,
} from '../../src/fiscal/assistant/language-model.port.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-11';

/**
 * Modelo dublado. Cada teste diz o que ele responde a partir das evidências
 * recebidas — o que se confere é o que o serviço faz com a resposta, e o que
 * ele entrega ao modelo.
 */
class ModeloDublado implements LanguageModelPort {
  readonly name = 'modelo-dublado';
  pedidos: ModelRequest[] = [];
  responder: (request: ModelRequest) => ModelAnswer | Promise<ModelAnswer> = () => ({
    answerable: false,
    reason: 'sem resposta programada',
    claims: [],
  });

  async complete(request: ModelRequest): Promise<ModelAnswer> {
    this.pedidos.push(request);
    return this.responder(request);
  }
}

interface Answer {
  intent: string;
  tier: number;
  confidence: string;
  answerable: boolean;
  claims: { kind: string; text: string; citations: { kind: string; period?: string }[] }[];
  unanswerableReason?: string;
}

describe.skipIf(!DATABASE_URL)('API — assistente, camada 3 com modelo de linguagem', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let modelo: ModeloDublado;
  let owner: string;
  let cnpj: string;
  let thread: string;

  const token = async (): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await token()}` },
      ...(payload === undefined ? {} : { payload }),
    });

  const perguntar = async (question: string): Promise<Answer> => {
    const r = await call('POST', `/v1/clients/${cnpj}/assistant/threads/${thread}/messages`, { question });
    if (r.statusCode !== 201) {
      throw new Error(`pergunta falhou ${r.statusCode}: ${r.body.slice(0, 300)}`);
    }
    return r.json().answer;
  };

  /** Pergunta que o classificador não reconhece: vai para a camada 3. */
  const LIVRE = 'resuma para mim a situação deste cliente';

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
    modelo = new ModeloDublado();
    app = await buildServer({ env, pool, languageModel: modelo });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    const tenantId = await createTenant(pool, 'Escritório da Camada 3');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
    thread = (await call('POST', `/v1/clients/${cnpj}/assistant/threads`, { title: 'Livre' })).json().id;
    modelo.pedidos = [];
  });

  it('capabilities diz que há modelo, e qual', async () => {
    const r = await call('GET', '/v1/assistant/capabilities');

    expect(r.json()).toMatchObject({
      deterministic_only: false,
      language_model_configured: true,
      language_model: 'modelo-dublado',
    });
  });

  it('pergunta reconhecida não passa pelo modelo', async () => {
    const answer = await perguntar('quantas notas entraram?');

    expect(answer.tier).toBe(1);
    expect(modelo.pedidos).toHaveLength(0);
  });

  /** O modelo não vê o banco: só os fatos que a camada 1 trouxe, numerados. */
  it('o modelo recebe a pergunta e só evidências numeradas da camada 1', async () => {
    await perguntar(LIVRE);

    expect(modelo.pedidos).toHaveLength(1);
    const pedido = modelo.pedidos[0]!;
    expect(pedido.question).toBe(LIVRE);
    expect(pedido.evidence.length).toBeGreaterThan(0);
    pedido.evidence.forEach((e, i) => expect(e.id).toBe(`E${i + 1}`));
    expect(pedido.evidence.some((e) => e.text.includes(PERIODO))).toBe(true);
  });

  it('resposta ancorada sai na camada 3, com as citações reais da evidência', async () => {
    modelo.responder = ({ evidence }) => {
      const e = evidence.find((x) => x.text.includes(PERIODO))!;
      return { answerable: true, reason: null, claims: [{ kind: 'fact', text: e.text, evidenceIds: [e.id] }] };
    };

    const answer = await perguntar(LIVRE);

    expect(answer).toMatchObject({ intent: 'desconhecido', tier: 3, confidence: 'medium', answerable: true });
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0]!.citations.length).toBeGreaterThan(0);
  });

  /** Citar a evidência certa com o número errado: a citação válida não carimba o valor. */
  it('valor em R$ que não está na evidência citada derruba a resposta', async () => {
    modelo.responder = ({ evidence }) => ({
      answerable: true,
      reason: null,
      claims: [{ kind: 'fact', text: 'O ICMS devido é R$ 9.999,99.', evidenceIds: [evidence[0]!.id] }],
    });

    const answer = await perguntar(LIVRE);

    expect(answer.answerable).toBe(false);
    expect(answer.claims).toHaveLength(0);
    expect(answer.unanswerableReason).toMatch(/R\$ 9\.999,99.*não está nas evidências/);
  });

  it('competência que não está na evidência também derruba', async () => {
    modelo.responder = ({ evidence }) => ({
      answerable: true,
      reason: null,
      claims: [{ kind: 'fact', text: 'A competência 2019-03 está fechada.', evidenceIds: [evidence[0]!.id] }],
    });

    expect((await perguntar(LIVRE)).unanswerableReason).toMatch(/2019-03/);
  });

  it('evidência inexistente derruba', async () => {
    modelo.responder = () => ({
      answerable: true,
      reason: null,
      claims: [{ kind: 'fact', text: 'Está tudo certo.', evidenceIds: ['E999'] }],
    });

    expect((await perguntar(LIVRE)).unanswerableReason).toMatch(/evidência inexistente/);
  });

  it('o "não sei" do modelo sai com o motivo que ele deu', async () => {
    modelo.responder = () => ({ answerable: false, reason: 'Faltaria o extrato bancário.', claims: [] });

    const answer = await perguntar(LIVRE);

    expect(answer).toMatchObject({ tier: 3, answerable: false });
    expect(answer.unanswerableReason).toBe('Faltaria o extrato bancário.');
  });

  /** Falha do modelo não vira 500: a pergunta já contou na cota. */
  it('erro do modelo vira "não sei" com o motivo, e não 500', async () => {
    modelo.responder = () => {
      throw new Error('rede fora do ar');
    };

    const answer = await perguntar(LIVRE);

    expect(answer.answerable).toBe(false);
    expect(answer.unanswerableReason).toMatch(/modelo-dublado não respondeu: rede fora do ar/);
  });

  it('a camada 3 não escreve no log fiscal', async () => {
    const antes = await pool.query('select count(*)::int n from events where cnpj = $1::char(14)', [cnpj]);
    modelo.responder = ({ evidence }) => ({
      answerable: true,
      reason: null,
      claims: [{ kind: 'fact', text: evidence[0]!.text, evidenceIds: [evidence[0]!.id] }],
    });

    await perguntar(LIVRE);

    const depois = await pool.query('select count(*)::int n from events where cnpj = $1::char(14)', [cnpj]);
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });
});
