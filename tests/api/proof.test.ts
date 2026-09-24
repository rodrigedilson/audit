import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { nfeXml } from '../helpers/nfe-xml.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-08';

describe.skipIf(!DATABASE_URL)('API — comprovante de integridade da competência', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let cnpj: string;
  let fornecedor: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
    userId: string = owner,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await tokenFor(userId)}` },
      ...(payload ? { payload } : {}),
    });

  const subir = async (xmls: string[]) => {
    const form = new FormData();
    xmls.forEach((xml, i) =>
      form.append('files', Buffer.from(xml, 'utf8'), { filename: `n${i}.xml` }),
    );
    return app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
      payload: form,
    });
  };

  const notaDeEntrada = (numero: string, comReforma = false) =>
    nfeXml({
      issuer: fornecedor,
      recipient: cnpj,
      numero,
      withReform: comReforma,
      issuedAt: `${PERIODO}-15T10:30:00-03:00`,
    });

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
    app = await buildServer({ env, pool });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    tenantId = await createTenant(pool, 'Escritório do Comprovante');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_presumido' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  it('emite o comprovante de uma competência recém-aberta', async () => {
    const body = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();

    expect(body).toMatchObject({ cnpj, period: PERIODO, state: 'open', ok: true });
    expect(body.replayed_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.documents).toEqual({ inbound: 0, outbound: 0, total: 0, cancelled: 0 });
    expect(body.confirmed_hash).toBeNull();
  });

  it('conta os documentos da competência por direção', async () => {
    await subir([notaDeEntrada('000000001', true), notaDeEntrada('000000002')]);

    const body = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();

    expect(body.documents).toMatchObject({ inbound: 2, total: 2 });
    expect(body.events_in_period).toBeGreaterThan(0);
    expect(body.ok).toBe(true);
  });

  /**
   * A prova que o comprovante existe para dar.
   *
   * O hash foi gravado no log no ato da confirmação. Reproduzi-lo exige replayar
   * os eventos anteriores àquele instante — então adulterar qualquer um deles
   * faz o número deixar de bater, que é exatamente o que um comprovante de
   * integridade tem de detectar.
   */
  describe('competência confirmada', () => {
    const confirmar = async (): Promise<string> => {
      await subir([notaDeEntrada('000000001', true)]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      // A máquina de estados exige `reconciled` antes de `confirmed`; a
      // contra-apuração que o produz não é o assunto deste teste.
      await pool.query(
        `select append_event($1::uuid, $2, gen_random_uuid(), 'assessment.compared',
                             $3::text, $4::text, $5::char(7), now(), '0.5.0', '{}'::jsonb)`,
        [tenantId, cnpj, PERIODO, owner, PERIODO],
      );

      const atual = (await call('POST', `/v1/clients/${cnpj}/verify`)).json();
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: atual.stored_hash,
      });
      return atual.stored_hash;
    };

    it('reproduz por replay o hash aprovado na confirmação', async () => {
      const hash = await confirmar();

      const body = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();

      expect(body.state).toBe('confirmed');
      expect(body.confirmed_hash).toBe(hash);
      expect(body.confirmed_hash_reproduced).toBe(true);
      expect(body.confirmed_at).not.toBeNull();
    });

    /**
     * Adulteração feita por fora da aplicação.
     *
     * O gatilho de append-only recusa `UPDATE` e `DELETE` — é a primeira tranca,
     * e ela funciona. Nos dois testes abaixo ela é contornada de propósito,
     * porque o cenário que o comprovante cobre é o de quem tem acesso ao banco e
     * passa por ela: um DBA, um backup restaurado por cima, uma migração
     * malfeita. É contra isso que o hash serve.
     */
    const adulterarLog = async (sql: string): Promise<void> => {
      const conexao = await pool.connect();
      try {
        await conexao.query('begin');
        await conexao.query(`set local session_replication_role = 'replica'`);
        await conexao.query(sql, [tenantId, cnpj]);
        await conexao.query('commit');
      } finally {
        conexao.release();
      }
    };

    /**
     * Evento removido nem chega ao hash: o replayer detecta o buraco na sequência
     * antes, e recusa projetar. São duas defesas em profundidade, e esta é a que
     * dispara primeiro.
     */
    it('evento removido derruba o replay por quebra de sequência', async () => {
      await confirmar();

      await adulterarLog(
        `delete from events
          where tenant_id = $1::uuid and cnpj = $2 and action = 'doc.received'`,
      );

      const response = await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`);

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('EVENT_STORE_CORRUPTED');
    });

    /**
     * Adulteração que preserva a sequência, e por isso passa pelo replayer: só o
     * hash a denuncia. Trocar `doc.received` por `doc.manifested` mantém o
     * `event_seq` intacto e muda a projeção, porque uma conta documento e a
     * outra não.
     */
    it('evento alterado com sequência intacta é pego pelo hash', async () => {
      await confirmar();

      const antes = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();
      expect(antes.confirmed_hash_reproduced).toBe(true);

      await adulterarLog(
        `update events set action = 'doc.manifested'
          where tenant_id = $1::uuid and cnpj = $2 and action = 'doc.received'`,
      );

      const depois = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();

      // O comprovante continua sendo emitido, com o defeito à mostra: esconder a
      // divergência seria o oposto do que o documento existe para fazer.
      expect(depois.confirmed_hash_reproduced).toBe(false);
      expect(depois.confirmed_hash).toBe(antes.confirmed_hash);
    });
  });

  it('competência não confirmada não tem hash a reproduzir', async () => {
    const body = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();

    expect(body.confirmed_hash_reproduced).toBeNull();
  });

  it('404 para competência que não existe', async () => {
    const response = await call('GET', `/v1/clients/${cnpj}/periods/2030-01/proof`);

    expect(response.statusCode).toBe(404);
  });

  it('recusa competência malformada', async () => {
    const response = await call('GET', `/v1/clients/${cnpj}/periods/2027-13/proof`);

    expect(response.statusCode).toBe(400);
  });

  /**
   * CNPJ de outro escritório responde 404, nunca 403: confirmar que existe já
   * seria vazamento (ADR-002).
   */
  it('404 para CNPJ de outro escritório', async () => {
    const outroTenant = await createTenant(pool, 'Outro escritório');
    const outroCnpj = randomCnpj();
    await createClient(pool, outroTenant, outroCnpj, { regime: 'lucro_real' });

    const response = await call('GET', `/v1/clients/${outroCnpj}/periods/${PERIODO}/proof`);

    expect(response.statusCode).toBe(404);
  });

  it('exige autenticação', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/clients/${cnpj}/periods/${PERIODO}/proof`,
    });

    expect(response.statusCode).toBe(401);
  });
});
