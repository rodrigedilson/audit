import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { nfeXml } from '../helpers/nfe-xml.js';

const executar = promisify(execFile);
const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-03';
const TSX = join(process.cwd(), 'node_modules/.bin/tsx');
const CLI = join(process.cwd(), 'src/cli/audit.ts');

/**
 * `audit close` roda como processo, como o operador o rodaria: o `main` da CLI
 * executa na importação, e o que se quer provar é o caminho inteiro — argumentos,
 * papel em `memberships`, serviço de confirmação e evento no log.
 */
describe.skipIf(!DATABASE_URL)('CLI — audit close', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
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

  const call = async (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${await token(owner)}` }, ...(payload ? { payload } : {}) });

  const close = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const r = await executar(TSX, [CLI, 'close', ...args], {
        env: { ...process.env, DATABASE_URL: DATABASE_URL!, LOG_LEVEL: 'silent' },
        cwd: process.cwd(),
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const erro = e as { code: number; stdout: string; stderr: string };
      return { code: erro.code, stdout: erro.stdout, stderr: erro.stderr };
    }
  };

  /** Apurada e conciliada: pronta para confirmar. Devolve o hash atual. */
  const prepararCompetencia = async (conciliar = true): Promise<string> => {
    const fornecedor = randomCnpj();
    const form = new FormData();
    form.append(
      'files',
      Buffer.from(nfeXml({ issuer: fornecedor, recipient: cnpj, numero: '000000001', issuedAt: `${PERIODO}-15T10:30:00-03:00` })),
      { filename: 'n.xml' },
    );
    await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await token(owner)}` },
      payload: form,
    });
    await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);
    if (conciliar) {
      await pool.query(
        `select append_event($1::uuid, $2, gen_random_uuid(), 'assessment.compared',
                             $3::text, $4::text, $5::char(7), now(), '0.5.0', '{}'::jsonb)`,
        [tenantId, cnpj, PERIODO, owner, PERIODO],
      );
    }
    return (await call('POST', `/v1/clients/${cnpj}/verify`)).json().stored_hash as string;
  };

  const base = (actor: string, hash: string) => [PERIODO, '--tenant', tenantId, '--cnpj', cnpj, '--actor', actor, '--hash', hash];

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
    tenantId = await createTenant(pool, 'Escritório da CLI');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_presumido' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  it('confirma com o hash conferido, e o comprovante reproduz o hash', async () => {
    const hash = await prepararCompetencia();

    const r = await close([...base(owner, hash), '--nota', 'fechado pela CLI']);

    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`${PERIODO} confirmada e fechada`));
    const prova = (await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json();
    expect(prova.state).toBe('confirmed');
    expect(prova.confirmed_hash).toBe(hash);
    expect(prova.confirmed_hash_reproduced).toBe(true);
    const { rows } = await pool.query(
      "select actor, payload->>'note' as nota from events where tenant_id = $1::uuid and cnpj = $2 and action = 'assessment.confirmed'",
      [tenantId, cnpj],
    );
    expect(rows).toEqual([{ actor: owner, nota: 'fechado pela CLI' }]);
  });

  it('recusa hash que não é o atual: confirma-se o que foi conferido', async () => {
    await prepararCompetencia();

    const r = await close(base(owner, 'a'.repeat(64)));

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/verification_mismatch/);
    expect((await call('GET', `/v1/clients/${cnpj}/periods/${PERIODO}/proof`)).json().state).not.toBe('confirmed');
  });

  it('recusa competência não conciliada', async () => {
    const hash = await prepararCompetencia(false);

    const r = await close(base(owner, hash));

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid_transition/);
  });

  it('recusa perfil viewer, e usuário de fora do escritório', async () => {
    const hash = await prepararCompetencia();
    const viewer = await createMembership(pool, tenantId, 'viewer');
    const outro = await createMembership(pool, await createTenant(pool, 'Outro'), 'owner');

    expect((await close(base(viewer, hash))).stderr).toMatch(/viewer/);
    expect((await close(base(outro, hash))).stderr).toMatch(/não pertence/);
  });

  it('argumentos faltando: uso, código 2', async () => {
    const r = await close([PERIODO, '--tenant', tenantId, '--cnpj', cnpj]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/close exige/);
  });
});
