import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import forge from 'node-forge';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const MASTER_KEY = 'chave-mestra-de-teste-com-mais-de-32-caracteres';
const AUDIENCE = 'authenticated';

function makePfx(password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0A1B2C3D';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date(Date.now() + 90 * 86_400_000);
  cert.setSubject([{ shortName: 'CN', value: 'EMPRESA EXEMPLO:12345678000195' }]);
  cert.setIssuer([{ shortName: 'CN', value: 'AC TESTE ICP-BRASIL' }]);
  cert.sign(keys.privateKey);
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password);
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

describe.skipIf(!DATABASE_URL)('API — escrita da carteira e cofre de certificados', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let accountant: string;
  let viewer: string;
  let cnpj: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    userId: string,
    payload?: Record<string, unknown>,
  ): Promise<import('light-my-request').Response> => {
    const options: import('light-my-request').InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${await tokenFor(userId)}` },
    };
    if (payload !== undefined) {
      options.payload = payload;
    }
    return app.inject(options);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const env = loadEnv({
      DATABASE_URL,
      SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
      SUPABASE_ANON_KEY: 'chave-anon-de-teste',
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_JWT_AUDIENCE: AUDIENCE,
      CERTIFICATE_MASTER_KEY: MASTER_KEY,
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
    tenantId = await createTenant(pool, 'Escritório de Escrita');
    owner = await createMembership(pool, tenantId, 'owner');
    accountant = await createMembership(pool, tenantId, 'accountant');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
  });

  describe('cadastro de empresa', () => {
    const body = () => ({
      cnpj,
      legal_name: 'Padaria do Bairro LTDA',
      trade_name: 'Padaria do Bairro',
      regime: 'simples_hibrido',
      uf: 'SP',
    });

    it('cadastra e devolve event_seq e projection_hash', async () => {
      const response = await call('POST', '/v1/clients', owner, body());

      expect(response.statusCode).toBe(201);
      const result = response.json();
      expect(result.action).toBe('client.enrolled');
      expect(result.event_seq).toBe(0);
      expect(result.projection_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('o cadastro nasce do event log, e a carteira o reflete', async () => {
      await call('POST', '/v1/clients', owner, body());

      const events = (await call('GET', `/v1/clients/${cnpj}/events`, owner)).json();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('client.enrolled');

      const carteira = (await call('GET', '/v1/clients', owner)).json();
      expect(carteira.items.map((c: { cnpj: string }) => c.cnpj)).toContain(cnpj);
    });

    /** Preço é por CNPJ ativo: cadastrar duas vezes cobraria duas vezes. */
    it('recusa cadastrar o mesmo CNPJ duas vezes', async () => {
      await call('POST', '/v1/clients', owner, body());

      const segunda = await call('POST', '/v1/clients', owner, body());

      expect(segunda.statusCode).toBe(403);
      expect(segunda.json().message).toMatch(/já está cadastrado/);
    });

    it('somente owner cadastra empresa', async () => {
      expect((await call('POST', '/v1/clients', accountant, body())).statusCode).toBe(403);
      expect((await call('POST', '/v1/clients', viewer, body())).statusCode).toBe(403);
    });

    it('recusa regime fora do vocabulário', async () => {
      const response = await call('POST', '/v1/clients', owner, {
        ...body(),
        regime: 'lucro_arbitrado',
      });

      expect(response.statusCode).toBe(400);
    });

    it('recusa CNPJ com máscara', async () => {
      const response = await call('POST', '/v1/clients', owner, {
        ...body(),
        cnpj: '12.345.678/0001-95',
      });

      expect(response.statusCode).toBe(400);
    });

    it('atualiza regime com vigência', async () => {
      await call('POST', '/v1/clients', owner, body());

      const response = await call('PATCH', `/v1/clients/${cnpj}`, owner, {
        regime: 'lucro_presumido',
        regime_effective_from: '2028-01',
      });

      expect(response.statusCode).toBe(200);
      expect((await call('GET', `/v1/clients/${cnpj}`, owner)).json().regime).toBe(
        'lucro_presumido',
      );
    });
  });

  describe('competências', () => {
    beforeEach(async () => {
      await createClient(pool, tenantId, cnpj);
    });

    it('abre competência e emite period.opened', async () => {
      const response = await call('POST', `/v1/clients/${cnpj}/periods`, accountant, {
        period: '2027-01',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().action).toBe('period.opened');

      const periodos = (await call('GET', `/v1/clients/${cnpj}/periods`, accountant)).json();
      expect(periodos).toEqual([
        expect.objectContaining({ period: '2027-01', state: 'open' }),
      ]);
    });

    /** Camada 4: a competência já existe, a transição não existe. */
    it('recusa reabrir competência já aberta, indicando a camada', async () => {
      await call('POST', `/v1/clients/${cnpj}/periods`, accountant, { period: '2027-01' });

      const segunda = await call('POST', `/v1/clients/${cnpj}/periods`, accountant, {
        period: '2027-01',
      });

      expect(segunda.statusCode).toBe(422);
      expect(segunda.json()).toMatchObject({ rejected: true, layer: 4 });
    });

    it('viewer não abre competência', async () => {
      const response = await call('POST', `/v1/clients/${cnpj}/periods`, viewer, {
        period: '2027-01',
      });

      expect(response.statusCode).toBe(403);
    });

    it('recusa competência fora do formato YYYY-MM', async () => {
      const response = await call('POST', `/v1/clients/${cnpj}/periods`, accountant, {
        period: '2027/01',
      });

      expect(response.statusCode).toBe(400);
    });

    /**
     * A rejeição também vira evento: é o que transforma "recusado" em
     * inconsistência auditável, com camada e motivo.
     */
    it('a rejeição do pipeline fica registrada no log', async () => {
      await call('POST', `/v1/clients/${cnpj}/periods`, accountant, { period: '2027-01' });
      await call('POST', `/v1/clients/${cnpj}/periods`, accountant, { period: '2027-01' });

      const rejeitados = (
        await call('GET', `/v1/clients/${cnpj}/events?action=output.rejected`, accountant)
      ).json();

      expect(rejeitados).toHaveLength(1);
      expect(rejeitados[0].payload).toMatchObject({ validation_layer: 4 });
    });
  });

  describe('cofre de certificados A1', () => {
    const upload = async (userId: string, password = 'senha-do-pfx') => {
      const form = new FormData();
      form.append('pfx', makePfx(password), { filename: 'cert.pfx' });
      form.append('password', password);

      return app.inject({
        method: 'PUT',
        url: `/v1/clients/${cnpj}/certificate`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(userId)}` },
        payload: form,
      });
    };

    beforeEach(async () => {
      await createClient(pool, tenantId, cnpj);
    });

    it('armazena o certificado e emite certificate.stored', async () => {
      const response = await upload(owner);

      expect(response.statusCode).toBe(200);
      expect(response.json().action).toBe('certificate.stored');
    });

    it('devolve metadados extraídos do PFX, e nunca o PFX', async () => {
      await upload(owner);

      const response = await call('GET', `/v1/clients/${cnpj}/certificate`, owner);
      const body = response.json();

      expect(body.subject).toContain('EMPRESA EXEMPLO');
      expect(body.issuer).toContain('AC TESTE ICP-BRASIL');
      expect(body.days_to_expiry).toBeGreaterThan(0);

      // O material sensível não pode aparecer em nenhuma forma na resposta.
      const serializado = JSON.stringify(body);
      expect(serializado).not.toContain('encrypted_pfx');
      expect(serializado).not.toContain('pfx');
      expect(serializado).not.toContain('senha');
    });

    it('guarda o PFX cifrado, não em claro', async () => {
      await upload(owner);

      const { rows } = await pool.query<{ encrypted_pfx: string; fingerprint: string }>(
        'select encrypted_pfx, fingerprint from certificates where tenant_id = $1::uuid and cnpj = $2',
        [tenantId, cnpj],
      );

      // Formato iv:authTag:ciphertext, e nada de DER legível.
      expect(rows[0]!.encrypted_pfx.split(':')).toHaveLength(3);
      expect(rows[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a senha do certificado não é persistida em lugar algum', async () => {
      await upload(owner, 'senha-muito-secreta');

      const { rows } = await pool.query<{ linha: string }>(
        `select certificates::text as linha from certificates
          where tenant_id = $1::uuid and cnpj = $2`,
        [tenantId, cnpj],
      );
      const { rows: eventos } = await pool.query<{ payload: string }>(
        `select payload::text as payload from events
          where tenant_id = $1::uuid and cnpj = $2 and action = 'certificate.stored'`,
        [tenantId, cnpj],
      );

      expect(rows[0]!.linha).not.toContain('senha-muito-secreta');
      expect(eventos[0]!.payload).not.toContain('senha-muito-secreta');
    });

    it('somente owner guarda certificado', async () => {
      expect((await upload(accountant)).statusCode).toBe(403);
      expect((await upload(viewer)).statusCode).toBe(403);
    });

    it('recusa PFX com senha errada sem revelar a causa', async () => {
      const form = new FormData();
      form.append('pfx', makePfx('senha-correta'), { filename: 'cert.pfx' });
      form.append('password', 'senha-errada');

      const response = await app.inject({
        method: 'PUT',
        url: `/v1/clients/${cnpj}/certificate`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().message).toMatch(/arquivo ou senha inválidos/);
    });

    it('remove o certificado e emite certificate.removed', async () => {
      await upload(owner);

      const response = await call('DELETE', `/v1/clients/${cnpj}/certificate`, owner);

      expect(response.statusCode).toBe(200);
      expect(response.json().action).toBe('certificate.removed');
      expect((await call('GET', `/v1/clients/${cnpj}/certificate`, owner)).statusCode).toBe(404);
    });

    it('lista certificados vencendo na carteira', async () => {
      await upload(owner);

      const response = await call('GET', '/v1/certificates/expiring?days=120', owner);

      expect(response.json()).toHaveLength(1);
      expect(response.json()[0].cnpj).toBe(cnpj);
    });

    it('não lista certificado com validade além da janela', async () => {
      await upload(owner);

      expect((await call('GET', '/v1/certificates/expiring?days=10', owner)).json()).toHaveLength(0);
    });

    it('log de uso começa vazio e é projeção dos eventos', async () => {
      await upload(owner);

      const response = await call('GET', `/v1/clients/${cnpj}/certificate/usage`, owner);

      expect(response.json()).toMatchObject({ items: [], total: 0 });
    });
  });
});
