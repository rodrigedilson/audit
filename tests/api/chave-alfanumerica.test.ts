import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { computeCheckDigit } from '../../src/fiscal/ingestion/access-key.js';
import { digitosVerificadoresDeCnpj } from '../../src/esaa/shared/domain/cnpj.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-11';

/** Emitente com CNPJ alfanumérico: letras garantidas, e DV válido. */
const EMITENTE = '12ABC345DE01' + digitosVerificadoresDeCnpj('12ABC345DE01');

function chave(numero: string): string {
  const base = '35' + '2711' + EMITENTE + '55' + '001' + numero.padStart(9, '0') + '1' + '23456789';
  return base + computeCheckDigit(base);
}

function nfe(destinatario: string, numero: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${chave(numero)}" versao="4.00">
  <ide><serie>001</serie><nNF>${numero}</nNF><dhEmi>2027-11-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${EMITENTE}</CNPJ><xNome>EMPRESA NOVA</xNome></emit>
  <dest><CNPJ>${destinatario}</CNPJ><xNome>CLIENTE</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto><ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS></imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

/**
 * A primeira NF-e de um emitente com CNPJ alfanumérico. Antes da migration
 * `20260924150000_chave_alfanumerica`, `documents.access_key` exigia só
 * dígitos, e a ingestão virava erro de banco.
 */
describe.skipIf(!DATABASE_URL)('API — chave de acesso com CNPJ alfanumérico', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let owner: string;
  let cnpj: string;

  const token = async (): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const subir = async (xml: string) => {
    const form = new FormData();
    form.append('files', Buffer.from(xml), { filename: 'n.xml' });
    return app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await token()}` },
      payload: form,
    });
  };

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
    const tenantId = await createTenant(pool, 'Escritório da Chave Alfanumérica');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj);
    await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/periods`,
      headers: { authorization: `Bearer ${await token()}` },
      payload: { period: PERIODO },
    });
  });

  it('a nota entra, com a chave alfanumérica gravada', async () => {
    const r = await subir(nfe(cnpj, '15'));

    // 207 sempre: a ingestão devolve o mesmo formato com ou sem rejeição.
    expect(r.statusCode).toBe(207);
    expect(r.json().accepted[0].access_key).toBe(chave('15'));
    expect(r.json().rejected).toEqual([]);
  });

  it('GET /documents/{chave} aceita a chave com letras', async () => {
    await subir(nfe(cnpj, '16'));

    const r = await app.inject({
      method: 'GET',
      url: `/v1/clients/${cnpj}/documents/${chave('16')}`,
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(r.statusCode).toBe(200);
  });

  /** A rejeição cita a chave, e ela é recuperada da mensagem para o `rejected`. */
  it('a duplicata sai com a chave alfanumérica no rejected', async () => {
    await subir(nfe(cnpj, '17'));
    const r = await subir(nfe(cnpj, '17'));

    expect(r.json().rejected[0].access_key).toBe(chave('17'));
  });
});
