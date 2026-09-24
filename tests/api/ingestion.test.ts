import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { computeCheckDigit } from '../../src/fiscal/ingestion/access-key.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

/** Chave coerente: cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8). */
function accessKey(issuer: string, numero = '000000015', model = '55'): string {
  const base = `35` + `2708` + issuer + model + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

interface XmlOptions {
  issuer: string;
  recipient: string;
  numero?: string;
  withReform?: boolean;
  issuedAt?: string;
}

function nfeXml(options: XmlOptions): string {
  const key = accessKey(options.issuer, options.numero ?? '000000015');
  const reform = options.withReform
    ? `<IBSCBS>
         <CST>000</CST><cClassTrib>000001</cClassTrib>
         <gIBSCBS>
           <vBC>1000.00</vBC>
           <gIBS>
             <gIBSUF><pIBSUF>0.10</pIBSUF><vIBSUF>1.00</vIBSUF></gIBSUF>
             <gIBSMun><pIBSMun>0.00</pIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun>
           </gIBS>
           <gCBS><pCBS>9.21</pCBS><vCBS>92.10</vCBS></gCBS>
         </gIBSCBS>
       </IBSCBS>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>15</nNF><dhEmi>${options.issuedAt ?? '2027-08-15T10:30:00-03:00'}</dhEmi></ide>
  <emit><CNPJ>${options.issuer}</CNPJ><xNome>EMITENTE LTDA</xNome></emit>
  <dest><CNPJ>${options.recipient}</CNPJ><xNome>DESTINATARIO LTDA</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
      ${reform}
    </imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

describe.skipIf(!DATABASE_URL)('API — ingestão de documentos', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let viewer: string;
  let cnpj: string;
  let outroCnpj: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const get = async (url: string, userId: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await tokenFor(userId)}` },
    });

  const upload = async (xmls: { name: string; content: string }[], userId: string) => {
    const form = new FormData();
    for (const xml of xmls) {
      form.append('files', Buffer.from(xml.content, 'utf8'), { filename: xml.name });
    }
    return app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(userId)}` },
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
    tenantId = await createTenant(pool, 'Escritório de Ingestão');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    outroCnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj);
    await openPeriod('2027-08');
  });

  /**
   * A competência tem de existir antes da ingestão. É a camada 4 do pipeline, e
   * é regra de produto: abrir a competência é o contador declarando que trabalha
   * naquele mês. Auto-abrir criaria competências em silêncio a partir de
   * qualquer nota antiga que chegasse na distribuição DF-e.
   */
  const openPeriod = async (period: string): Promise<void> => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/periods`,
      headers: { authorization: `Bearer ${await tokenFor(owner)}` },
      payload: { period },
    });
    if (response.statusCode !== 201) {
      throw new Error(`falha ao abrir competência ${period}: ${response.body}`);
    }
  };

  describe('upload de XML', () => {
    it('aceita uma nota e devolve 207 com event_seq e hash', async () => {
      const response = await upload(
        [{ name: 'nota.xml', content: nfeXml({ issuer: outroCnpj, recipient: cnpj }) }],
        owner,
      );

      expect(response.statusCode).toBe(207);
      const body = response.json();
      expect(body.rejected).toHaveLength(0);
      expect(body.accepted).toHaveLength(1);
      expect(body.accepted[0]).toMatchObject({ direction: 'inbound', period: '2027-08' });
      expect(body.accepted[0].projection_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    /**
     * Direção é pela ótica do CNPJ do escopo: o mesmo XML é saída para quem
     * emitiu e entrada para quem recebeu, e a apuração trata os dois de formas
     * opostas.
     */
    it('classifica como saída quando o CNPJ do escopo é o emitente', async () => {
      const response = await upload(
        [{ name: 'saida.xml', content: nfeXml({ issuer: cnpj, recipient: outroCnpj }) }],
        owner,
      );

      expect(response.json().accepted[0].direction).toBe('outbound');
    });

    /** Uma nota com problema não pode impedir as outras de entrarem. */
    it('um arquivo inválido não interrompe o lote', async () => {
      const response = await upload(
        [
          { name: 'boa.xml', content: nfeXml({ issuer: outroCnpj, recipient: cnpj }) },
          { name: 'quebrada.xml', content: '<nfeProc><NFe>' },
          {
            name: 'outra-boa.xml',
            content: nfeXml({ issuer: outroCnpj, recipient: cnpj, numero: '000000016' }),
          },
        ],
        owner,
      );

      const body = response.json();
      expect(body.accepted).toHaveLength(2);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0]).toMatchObject({ filename: 'quebrada.xml', layer: 1 });
    });

    it('a rejeição carrega camada e motivo, e nomeia o arquivo', async () => {
      const response = await upload([{ name: 'pedido.xml', content: '<pedido/>' }], owner);

      expect(response.json().rejected[0]).toMatchObject({
        rejected: true,
        filename: 'pedido.xml',
        layer: 2,
        reason: 'schema_violation',
      });
    });

    /** Sem isso o contador não prova depois que o documento chegou e foi recusado. */
    it('a rejeição fica registrada no event log', async () => {
      await upload([{ name: 'ruim.xml', content: '<pedido/>' }], owner);

      const eventos = (
        await get(`/v1/clients/${cnpj}/events?action=output.rejected`, owner)
      ).json();

      expect(eventos).toHaveLength(1);
      expect(eventos[0].payload).toMatchObject({
        original_action: 'doc.received',
        validation_layer: 2,
        filename: 'ruim.xml',
      });
    });

    it('recusa documento já recebido, com motivo duplicate_document', async () => {
      const xml = nfeXml({ issuer: outroCnpj, recipient: cnpj });

      await upload([{ name: 'primeira.xml', content: xml }], owner);
      const segunda = await upload([{ name: 'repetida.xml', content: xml }], owner);

      expect(segunda.json().rejected[0]).toMatchObject({ reason: 'duplicate_document', layer: 2 });
      expect(segunda.json().accepted).toHaveLength(0);
    });

    it('recusa duplicata dentro do mesmo lote', async () => {
      const xml = nfeXml({ issuer: outroCnpj, recipient: cnpj });

      const response = await upload(
        [
          { name: 'a.xml', content: xml },
          { name: 'b.xml', content: xml },
        ],
        owner,
      );

      expect(response.json().accepted).toHaveLength(1);
      expect(response.json().rejected[0].reason).toBe('duplicate_document');
    });

    it('recusa lote vazio', async () => {
      const form = new FormData();
      form.append('nada', 'x');

      const response = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/documents`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(response.statusCode).toBe(422);
    });

    it('recusa documento de competência não aberta, na camada 4', async () => {
      const response = await upload(
        [
          {
            name: 'setembro.xml',
            content: nfeXml({
              issuer: outroCnpj,
              recipient: cnpj,
              numero: '000000099',
              issuedAt: '2027-09-10T10:00:00-03:00',
            }),
          },
        ],
        owner,
      );

      expect(response.json().accepted).toHaveLength(0);
      expect(response.json().rejected[0]).toMatchObject({ layer: 4 });
      expect(response.json().rejected[0].message).toMatch(/não foi aberta/);
    });

    it('viewer não ingere documento', async () => {
      const response = await upload(
        [{ name: 'nota.xml', content: nfeXml({ issuer: outroCnpj, recipient: cnpj }) }],
        viewer,
      );

      expect(response.statusCode).toBe(403);
    });
  });

  describe('consulta de documentos', () => {
    beforeEach(async () => {
      await upload(
        [
          { name: 'entrada.xml', content: nfeXml({ issuer: outroCnpj, recipient: cnpj }) },
          {
            name: 'saida.xml',
            content: nfeXml({ issuer: cnpj, recipient: outroCnpj, numero: '000000020' }),
          },
          {
            name: 'reforma.xml',
            content: nfeXml({
              issuer: outroCnpj,
              recipient: cnpj,
              numero: '000000030',
              withReform: true,
            }),
          },
        ],
        owner,
      );
    });

    it('lista os documentos do CNPJ', async () => {
      const body = (await get(`/v1/clients/${cnpj}/documents`, owner)).json();

      expect(body.items).toHaveLength(3);
      expect(body.total).toBe(3);
    });

    it('filtra por direção', async () => {
      const entradas = (await get(`/v1/clients/${cnpj}/documents?direction=inbound`, owner)).json();

      expect(entradas.items).toHaveLength(2);
    });

    it('filtra por competência', async () => {
      expect(
        (await get(`/v1/clients/${cnpj}/documents?period=2027-08`, owner)).json().items,
      ).toHaveLength(3);
      expect(
        (await get(`/v1/clients/${cnpj}/documents?period=2027-09`, owner)).json().items,
      ).toHaveLength(0);
    });

    /** Indicador de prontidão da carteira para a reforma. */
    it('filtra por presença do grupo UB (IBS/CBS)', async () => {
      const comReforma = (
        await get(`/v1/clients/${cnpj}/documents?has_reform_group=true`, owner)
      ).json();

      expect(comReforma.items).toHaveLength(1);
    });

    it('devolve o documento com itens e os dois sistemas de tributos', async () => {
      const key = accessKey(outroCnpj, '000000030');
      const body = (await get(`/v1/clients/${cnpj}/documents/${key}`, owner)).json();

      expect(body.items).toHaveLength(1);
      expect(body.items[0].legacy_taxes.icms.amountCents).toBe(18_000);
      expect(body.items[0].reform_taxes.cbs.amountCents).toBe(9_210);
      expect(body.has_reform_group).toBe(true);
    });

    it('404 para documento inexistente', async () => {
      const response = await get(
        `/v1/clients/${cnpj}/documents/${accessKey(outroCnpj, '000000999')}`,
        owner,
      );

      expect(response.statusCode).toBe(404);
    });

    it('conta os documentos recebidos na projeção do CNPJ', async () => {
      const verify = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/verify`,
        headers: { authorization: `Bearer ${await tokenFor(owner)}` },
      });

      expect(verify.json().ok).toBe(true);
      // period.opened + 3 doc.received
      expect(verify.json().last_event_seq).toBe(3);
    });
  });

  describe('importações que dependem de fonte externa', () => {
    /**
     * Enfileirar sem consumidor seria pior do que dizer que não está pronto: o
     * escritório ficaria esperando um job que nunca sai de `queued`.
     */
    /**
     * Sobrou só a coleta DF-e. O extrato saiu na Onda 10 (upload de OFX/CSV) e a
     * EFD-Contribuições na Onda 12 (upload do arquivo) — as duas deixaram de ser
     * promessa e viraram rota que funciona.
     */
    /** Dev não fala com a SEFAZ (ADR-006); a coleta de verdade está em dfe-sync.test.ts. */
    it('sem gateway da SEFAZ, a coleta responde 503 apontando o upload manual', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/sync`,
        headers: { authorization: `Bearer ${await tokenFor(owner)}` },
        payload: {},
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().message).toMatch(/upload manual/);
    });

    it('404 para job de outro escritório, sem confirmar existência', async () => {
      const outroTenant = await createTenant(pool, 'Outro');
      const { rows } = await pool.query<{ id: string }>(
        `insert into jobs (tenant_id, kind) values ($1::uuid, 'dfe_sync') returning id`,
        [outroTenant],
      );

      expect((await get(`/v1/jobs/${rows[0]!.id}`, owner)).statusCode).toBe(404);
    });
  });
});
