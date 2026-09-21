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
const PERIODO = '2027-12';

function accessKey(issuer: string, numero: string): string {
  const base = '35' + '2712' + issuer + '55' + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

/** Nota de entrada com IBS/CBS destacado: é ela que gera crédito condicionado. */
function nfeXml(
  issuer: string,
  recipient: string,
  numero: string,
  options: { withReform?: boolean; issuedAt?: string; totalReais?: string } = {},
): string {
  const key = accessKey(issuer, numero);
  const total = options.totalReais ?? '1000.00';
  const reforma =
    options.withReform === false
      ? ''
      : `<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib>
           <gIBSCBS><vBC>${total}</vBC>
             <gIBS><gIBSUF><pIBSUF>0.10</pIBSUF><vIBSUF>1.00</vIBSUF></gIBSUF></gIBS>
             <gCBS><pCBS>9.21</pCBS><vCBS>92.10</vCBS></gCBS>
           </gIBSCBS></IBSCBS>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>${Number(numero)}</nNF>
    <dhEmi>${options.issuedAt ?? '2027-12-05T10:30:00-03:00'}</dhEmi></ide>
  <emit><CNPJ>${issuer}</CNPJ><xNome>FORNECEDOR LTDA</xNome></emit>
  <dest><CNPJ>${recipient}</CNPJ><xNome>DESTINATARIO</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>1102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>${total}</vUnCom><vProd>${total}</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>${total}</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
      ${reforma}
    </imposto>
  </det>
  <total><ICMSTot><vNF>${total}</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

function ofx(...transacoes: string[]): string {
  return `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>12345-6</ACCTID></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20271201<DTEND>20271231
${transacoes.join('\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

const pagamento = (fitid: string, valor: string, data = '20271215', memo = 'PAGTO FORNECEDOR') =>
  `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${data}<TRNAMT>${valor}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`;

interface Fornecedor {
  supplierCnpj: string;
  supplierName: string | null;
  documents: number;
  creditConditionedCents: number;
  creditAtRiskCents: number;
  creditExpectedCents: number;
  oldestUnpaidDays: number | null;
  emitsReformGroup: boolean;
}

describe.skipIf(!DATABASE_URL)('API — crédito em risco por fornecedor', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let viewer: string;
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
    userId?: string,
  ): Promise<import('light-my-request').Response> => {
    const options: import('light-my-request').InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${await tokenFor(userId ?? owner)}` },
    };
    if (payload !== undefined) options.payload = payload;
    return app.inject(options);
  };

  const subir = async (xmls: string[]): Promise<void> => {
    const form = new FormData();
    xmls.forEach((xml, i) =>
      form.append('files', Buffer.from(xml, 'utf8'), { filename: `n${i}.xml` }),
    );
    const r = await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
      payload: form,
    });
    const body = r.json();
    if (body.rejected.length > 0) {
      throw new Error(`ingestão rejeitou: ${JSON.stringify(body.rejected)}`);
    }
  };

  const importar = async (conteudo: string): Promise<import('light-my-request').Response> =>
    app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/bank-statements`,
      headers: {
        authorization: `Bearer ${await tokenFor(owner)}`,
        'content-type': 'text/csv',
      },
      payload: conteudo,
    });

  const risco = async (period?: string): Promise<{
    statements_imported: boolean;
    suppliers: Fornecedor[];
    totals: Record<string, number>;
  }> =>
    (
      await call(
        'GET',
        `/v1/clients/${cnpj}/credits/at-risk${period === undefined ? '' : `?period=${period}`}`,
      )
    ).json();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const env = loadEnv({
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
    tenantId = await createTenant(pool, 'Escritório do Crédito');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('importação de extrato', () => {
    it('importa OFX e emite bank.statement.imported', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/bank-statements`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/plain',
        },
        payload: ofx(pagamento('F1', '-1000.00')),
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().source).toBe('ofx');
      expect(r.json().account).toBe('12345-6');
      expect(r.json().lines_imported).toBe(1);

      const { rows } = await pool.query(
        `select 1 from events where tenant_id = $1::uuid and cnpj = $2::char(14)
           and action = 'bank.statement.imported'`,
        [tenantId, cnpj],
      );
      expect(rows).toHaveLength(1);
    });

    it('importa CSV com data brasileira', async () => {
      const r = await importar('data;valor;historico\n15/12/2027;-1.000,00;PAGTO');

      expect(r.statusCode).toBe(201);
      expect(r.json().source).toBe('csv');
      expect(r.json().lines_imported).toBe(1);
    });

    /**
     * O mesmo extrato enviado duas vezes não pode dobrar o pagamento, senão um
     * crédito apareceria com liquidação que aconteceu uma vez só.
     */
    it('reimportar o mesmo extrato não duplica lançamento', async () => {
      const arquivo = ofx(pagamento('F1', '-1000.00'), pagamento('F2', '-500.00'));

      const primeira = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/bank-statements`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/plain',
        },
        payload: arquivo,
      });
      const segunda = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/bank-statements`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/plain',
        },
        payload: arquivo,
      });

      expect(primeira.json().lines_imported).toBe(2);
      expect(segunda.json().lines_imported).toBe(0);
      expect(segunda.json().lines_duplicated).toBe(2);

      const { rows } = await pool.query<{ total: string }>(
        `select count(*)::text as total from bank_statement_lines
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );
      expect(rows[0]!.total).toBe('2');
    });

    it('recusa arquivo irreconhecível na camada 1', async () => {
      const r = await importar('isto não é extrato nenhum');

      expect(r.statusCode).toBe(422);
      expect(r.json().layer).toBe(1);
    });

    it('extrato sem lançamento aproveitável é recusado com o motivo', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/bank-statements`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/plain',
        },
        payload: ofx('<STMTTRN><DTPOSTED>20271215<TRNAMT>-10.00<MEMO>sem fitid</STMTTRN>'),
      });

      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/duplicidade/);
    });

    it('aceita multipart também, guardando o nome do arquivo', async () => {
      const form = new FormData();
      form.append('file', Buffer.from(ofx(pagamento('F1', '-1000.00')), 'utf8'), {
        filename: 'extrato-dezembro.ofx',
      });

      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/bank-statements`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().reference).toBe('extrato-dezembro.ofx');
    });

    it('viewer não importa extrato', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/bank-statements`,
        headers: {
          authorization: `Bearer ${await tokenFor(viewer)}`,
          'content-type': 'text/csv',
        },
        payload: 'data;valor\n2027-12-15;-10,00',
      });

      expect(r.statusCode).toBe(403);
    });
  });

  describe('casamento pagamento × documento', () => {
    it('casa por valor e data dentro da janela', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      const r = await importar('data;valor;historico\n2027-12-15;-1.000,00;PAGTO FORNECEDOR');

      expect(r.json().matches).toHaveLength(1);
      expect(r.json().matches[0].confidence).toBe('amount_and_date');
    });

    it('casa como exact quando a chave está no histórico', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      const chave = accessKey(fornecedor, '000000015');

      const r = await importar(`data;valor;historico\n2027-12-15;-1.000,00;PIX ref ${chave}`);

      expect(r.json().matches[0].confidence).toBe('exact');
    });

    /**
     * Dois documentos de igual valor são indistinguíveis por valor e data.
     * Escolher um produziria uma afirmação sem base — e liberaria crédito da
     * nota errada.
     */
    it('dois documentos de igual valor produzem casamento ambíguo', async () => {
      await subir([
        nfeXml(fornecedor, cnpj, '000000015'),
        nfeXml(fornecedor, cnpj, '000000016'),
      ]);

      const r = await importar('data;valor;historico\n2027-12-15;-1.000,00;PAGTO');

      expect(r.json().matches[0].confidence).toBe('ambiguous');
      expect(r.json().ambiguous).toBe(1);
      expect(r.json().matches[0].candidates).toHaveLength(2);
    });

    /**
     * Refeito por inteiro, e não incremental: um documento novo pode criar
     * candidato para um lançamento que não tinha nenhum.
     */
    it('refazer o casamento depois de ingerir documento novo encontra o par', async () => {
      await importar('data;valor;historico\n2027-12-15;-1.000,00;PAGTO');
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      const r = await call('POST', `/v1/clients/${cnpj}/payment-matches`);

      expect(r.json().total).toBe(1);
      expect(r.json().matches[0].confidence).toBe('amount_and_date');
    });

    it('o casamento gravado traz o motivo, para o contador conferir', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar('data;valor;historico\n2027-12-15;-1.000,00;PAGTO');

      const { rows } = await pool.query<{ rationale: string; confidence: string }>(
        'select rationale, confidence from payment_matches where tenant_id = $1::uuid',
        [tenantId],
      );

      expect(rows[0]!.confidence).toBe('amount_and_date');
      expect(rows[0]!.rationale).toMatch(/Valor idêntico/);
    });
  });

  describe('crédito por fornecedor', () => {
    /**
     * Sem extrato, todo crédito da reforma aparece condicionado por falta de
     * pagamento identificado — indistinguível de "o cliente não pagou ninguém".
     * A tela precisa da diferença.
     */
    it('declara quando nenhum extrato foi importado', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      const r = await risco();

      expect(r.statements_imported).toBe(false);
      expect(r.suppliers[0]!.creditConditionedCents).toBeGreaterThan(0);
    });

    it('crédito da reforma sem pagamento fica condicionado', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      const r = await risco();

      expect(r.suppliers[0]!.supplierCnpj).toBe(fornecedor);
      expect(r.suppliers[0]!.supplierName).toBe('FORNECEDOR LTDA');
      // IBS-UF 1,00 + CBS 92,10
      expect(r.suppliers[0]!.creditConditionedCents).toBe(9_310);
      expect(r.suppliers[0]!.emitsReformGroup).toBe(true);
    });

    /**
     * ICMS nasce do documento e não depende de liquidação nenhuma. Tratá-lo
     * como condicionado reportaria risco onde não há.
     */
    it('crédito de ICMS aparece como esperado, não condicionado', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      const r = await risco();

      expect(r.totals['expectedCents']).toBe(18_000);
    });

    /**
     * A honestidade central: nós pagamos, mas não temos como observar que o
     * tributo do fornecedor foi extinguido. Chamar de liberado seria a
     * afirmação que o Fisco depois glosaria.
     */
    it('pagamento identificado NÃO libera o crédito da reforma', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar('data;valor;historico\n2027-12-15;-1.000,00;PAGTO');

      const r = await risco();

      expect(r.totals['releasedCents']).toBe(0);
      expect(r.suppliers[0]!.creditConditionedCents).toBe(9_310);
      expect(r.suppliers[0]!.oldestUnpaidDays).toBeNull();
    });

    it('documento sem grupo IBS/CBS não gera crédito da reforma a condicionar', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015', { withReform: false })]);

      const r = await risco();

      expect(r.suppliers[0]!.creditConditionedCents).toBe(0);
      expect(r.suppliers[0]!.emitsReformGroup).toBe(false);
    });

    it('filtra por competência quando pedido', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      expect((await risco(PERIODO)).suppliers).toHaveLength(1);
      expect((await risco('2026-01')).suppliers).toHaveLength(0);
    });

    it('nota de saída não entra no crédito de entrada', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);

      expect((await risco()).suppliers).toHaveLength(0);
    });

    it('separa fornecedores e ordena pelo maior condicionado', async () => {
      const outro = randomCnpj();
      await subir([
        nfeXml(fornecedor, cnpj, '000000015', { totalReais: '1000.00' }),
        nfeXml(outro, cnpj, '000000016', { totalReais: '2000.00' }),
      ]);

      const r = await risco();

      expect(r.suppliers).toHaveLength(2);
      expect(r.suppliers[0]!.creditConditionedCents).toBeGreaterThanOrEqual(
        r.suppliers[1]!.creditConditionedCents,
      );
    });

    it('a carteira de outro escritório não vaza', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      const outro = await createTenant(pool, 'Escritório vizinho');
      const intruso = await createMembership(pool, outro, 'owner');
      await createClient(pool, outro, cnpj, { regime: 'lucro_real' });

      const r = await call(
        'GET',
        `/v1/clients/${cnpj}/credits/at-risk`,
        undefined,
        intruso,
      );

      expect(r.json().suppliers).toHaveLength(0);
    });

    it('cada posição carrega o motivo do estado', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      const posicoes = (
        await call('GET', `/v1/clients/${cnpj}/credits/at-risk`)
      ).json().positions;

      expect(posicoes.length).toBeGreaterThan(0);
      for (const posicao of posicoes) {
        expect(String(posicao.reason).trim().length).toBeGreaterThan(0);
      }
    });
  });
});
