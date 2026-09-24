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
const PERIODO = '2027-06';

function accessKey(issuer: string, numero: string): string {
  const base = '35' + '2706' + issuer + '55' + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

/** Nota de entrada com PIS e Cofins destacados: é o lastro do crédito. */
function nfeXml(issuer: string, recipient: string, numero: string, pis = '16.50'): string {
  const key = accessKey(issuer, numero);

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>${Number(numero)}</nNF><dhEmi>2027-06-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${issuer}</CNPJ><xNome>FORNECEDOR LTDA</xNome></emit>
  <dest><CNPJ>${recipient}</CNPJ><xNome>DESTINATARIO</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>1102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
      <PIS><PISAliq><CST>50</CST><vBC>1000.00</vBC><pPIS>1.65</pPIS><vPIS>${pis}</vPIS></PISAliq></PIS>
      <COFINS><COFINSAliq><CST>50</CST><vBC>1000.00</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>76.00</vCOFINS></COFINSAliq></COFINS>
    </imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

const reg = (...campos: string[]): string => `|${campos.join('|')}|`;

function abertura(cnpj: string, tipo = '0'): string {
  return reg(
    '0000',
    '006',
    tipo,
    '',
    '',
    '01062027',
    '30062027',
    'CLIENTE LTDA',
    cnpj,
    'SP',
    '3550308',
    '',
    '00',
    '1',
  );
}

const c100 = (chave: string | null, operacao = '0'): string =>
  reg('C100', operacao, '0', 'FORN1', '55', '00', '1', '1', chave ?? '', '15062027', '15062027', '1000,00');

const c170 = (pis = '16,50', cofins = '76,00'): string =>
  reg(
    'C170',
    '1',
    'SKU-1',
    'Produto',
    '1,0000',
    'UN',
    '1000,00',
    '0,00',
    '0',
    '00',
    '1102',
    ...Array(13).fill(''),
    '50',
    '1000,00',
    '1,6500',
    '',
    '',
    pis,
    '50',
    '1000,00',
    '7,6000',
    '',
    '',
    cofins,
  );

const r1100 = (competencia: string, saldo = '5000,00'): string =>
  reg(
    '1100',
    competencia,
    '0',
    '',
    '101',
    saldo,
    '0,00',
    saldo,
    '0,00',
    '0,00',
    '0,00',
    saldo,
    '0,00',
    '0,00',
    '0,00',
    '0,00',
    '0,00',
    saldo,
  );

interface Dossie {
  period: string;
  kind: string;
  coverage: { from: string | null; to: string | null; periods: string[] };
  checks: { status: string; reason: string; accessKey: string | null; differenceCents: number }[];
  carried: { withinCoverage: boolean; note: string; tax: string }[];
  summary: Record<string, number> & {
    carriedBalanceCents: { pis: number; cofins: number };
  };
}

describe.skipIf(!DATABASE_URL)('API — dossiê de saldo credor PIS/Cofins', () => {
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

  const importar = async (
    ...linhas: string[]
  ): Promise<import('light-my-request').Response> =>
    app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/sped`,
      headers: {
        authorization: `Bearer ${await tokenFor(owner)}`,
        'content-type': 'text/plain',
      },
      payload: linhas.join('\n'),
    });

  const dossie = async (period = PERIODO): Promise<Dossie> =>
    (await call('GET', `/v1/clients/${cnpj}/credit-dossier/${period}`)).json();

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
    tenantId = await createTenant(pool, 'Escritório do Dossiê');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('importação da EFD-Contribuições', () => {
    it('importa e emite sped.imported', async () => {
      const r = await importar(abertura(cnpj), c100(accessKey(fornecedor, '000000015')), c170());

      expect(r.statusCode).toBe(201);
      expect(r.json().period).toBe(PERIODO);
      expect(r.json().kind).toBe('original');
      expect(r.json().documents_count).toBe(1);

      const { rows } = await pool.query(
        `select 1 from events where tenant_id = $1::uuid and cnpj = $2::char(14)
           and action = 'sped.imported'`,
        [tenantId, cnpj],
      );
      expect(rows).toHaveLength(1);
    });

    it('lê o saldo credor de períodos anteriores', async () => {
      const r = await importar(abertura(cnpj), r1100('012027'), r1100('022027').replace('|1100|', '|1500|'));

      expect(r.json().carried_credits_count).toBe(2);
    });

    it('reconhece a escrituração retificadora', async () => {
      const r = await importar(abertura(cnpj, '1'));

      expect(r.json().kind).toBe('retificadora');
    });

    /**
     * Importar a EFD de um CNPJ na conta de outro produziria um dossiê que acusa
     * o cliente errado.
     */
    it('recusa arquivo de outro CNPJ, dizendo os dois', async () => {
      const outro = randomCnpj();

      const r = await importar(abertura(outro));

      expect(r.statusCode).toBe(422);
      expect(r.json().reason).toBe('tenant_violation');
      expect(r.json().message).toContain(outro);
      expect(r.json().message).toContain(cnpj);
    });

    it('recusa versão de layout desconhecida na camada 1', async () => {
      const r = await importar(abertura(cnpj).replace('|0000|006|', '|0000|002|'));

      expect(r.statusCode).toBe(422);
      expect(r.json().layer).toBe(1);
      expect(r.json().message).toMatch(/não suportada/);
    });

    it('recusa arquivo que não é EFD-Contribuições', async () => {
      const r = await importar('isto não é SPED nenhum');

      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/sem registro 0000/);
    });

    /** A retificadora substitui a original, como na própria EFD. */
    it('reimportar a competência substitui a escrituração anterior', async () => {
      await importar(abertura(cnpj), c100(accessKey(fornecedor, '000000015')), c170());
      await importar(
        abertura(cnpj, '1'),
        c100(accessKey(fornecedor, '000000015')),
        c170(),
        c100(accessKey(fornecedor, '000000016')),
        c170(),
      );

      const { rows } = await pool.query<{ arquivos: string; documentos: string }>(
        `select (select count(*)::text from sped_files
                  where tenant_id = $1::uuid and cnpj = $2::char(14)) as arquivos,
                (select count(*)::text from sped_documents
                  where tenant_id = $1::uuid and cnpj = $2::char(14)) as documentos`,
        [tenantId, cnpj],
      );

      expect(rows[0]!.arquivos).toBe('1');
      expect(rows[0]!.documentos).toBe('2');
      expect((await dossie()).kind).toBe('retificadora');
    });

    it('aceita multipart, guardando o nome do arquivo', async () => {
      const form = new FormData();
      form.append('file', Buffer.from(abertura(cnpj), 'latin1'), {
        filename: 'efd-062027.txt',
      });

      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/sped`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(r.statusCode).toBe(201);
      const { rows } = await pool.query<{ reference: string }>(
        'select reference from sped_files where tenant_id = $1::uuid',
        [tenantId],
      );
      expect(rows[0]!.reference).toBe('efd-062027.txt');
    });

    it('viewer não importa SPED', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/sped`,
        headers: {
          authorization: `Bearer ${await tokenFor(viewer)}`,
          'content-type': 'text/plain',
        },
        payload: abertura(cnpj),
      });

      expect(r.statusCode).toBe(403);
    });

    it('registro ruim volta no rejected sem derrubar o arquivo', async () => {
      const r = await importar(abertura(cnpj), c100('123'), c100(accessKey(fornecedor, '000000015')), c170());

      expect(r.statusCode).toBe(201);
      expect(r.json().documents_count).toBe(1);
      expect(r.json().rejected).toHaveLength(1);
    });
  });

  describe('lastro documental', () => {
    it('sem EFD importada, o dossiê é 404 e diz o que falta', async () => {
      const r = await call('GET', `/v1/clients/${cnpj}/credit-dossier/${PERIODO}`);

      expect(r.statusCode).toBe(404);
      expect(r.json().message).toMatch(/sem a escrituração não há o que conferir/);
    });

    it('documento na base com valores conferentes é lastreado', async () => {
      const chave = accessKey(fornecedor, '000000015');
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj), c100(chave), c170());

      const d = await dossie();

      expect(d.checks[0]!.status).toBe('lastreado');
      expect(d.summary['lastreado']).toBe(1);
      expect(d.summary['backedCents']).toBe(9_250);
    });

    it('valores divergentes apontam a diferença', async () => {
      const chave = accessKey(fornecedor, '000000015');
      await subir([nfeXml(fornecedor, cnpj, '000000015', '20.00')]);
      await importar(abertura(cnpj), c100(chave), c170());

      const d = await dossie();

      expect(d.checks[0]!.status).toBe('divergente');
      expect(d.checks[0]!.differenceCents).toBe(350);
    });

    /**
     * Dentro da cobertura, a ausência é do cliente: é o caso que o pente-fino
     * cobra.
     */
    it('crédito escriturado sem XML na base, com a competência coberta, é sem lastro', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj), c100(accessKey(fornecedor, '000000099')), c170());

      const d = await dossie();

      expect(d.checks[0]!.status).toBe('sem_documento');
      expect(d.checks[0]!.reason).toMatch(/pente-fino cobra/);
      expect(d.summary['unbackedCents']).toBe(9_250);
    });

    /**
     * A honestidade central da onda: sem documento nenhum da competência, a
     * ausência é da nossa coleta e não do cliente.
     */
    it('sem nenhum documento da competência, o crédito é NÃO VERIFICÁVEL', async () => {
      await importar(abertura(cnpj), c100(accessKey(fornecedor, '000000015')), c170());

      const d = await dossie();

      expect(d.checks[0]!.status).toBe('nao_verificavel');
      expect(d.checks[0]!.status).not.toBe('sem_documento');
      expect(d.checks[0]!.reason).toMatch(/limitação da nossa coleta/);
      expect(d.summary['unbackedCents']).toBe(0);
      expect(d.summary['unverifiableCents']).toBe(9_250);
    });

    it('nota em papel, sem chave, não é acusada de falta de lastro', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj), c100(null), c170());

      const d = await dossie();

      expect(d.checks[0]!.status).toBe('sem_chave');
      expect(d.summary['unbackedCents']).toBe(0);
    });

    it('documento de saída da EFD não entra na conferência de crédito', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj), c100(accessKey(cnpj, '000000020'), '1'), c170());

      const d = await dossie();

      expect(d.checks).toHaveLength(0);
    });

    it('a janela de cobertura vem no dossiê, para o contador conferir', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj));

      const d = await dossie();

      expect(d.coverage.from).toBe(PERIODO);
      expect(d.coverage.to).toBe(PERIODO);
      expect(d.coverage.periods).toEqual([PERIODO]);
    });

    /**
     * Derivado na leitura, e não guardado: localizar um XML que faltava é
     * exatamente o trabalho que o dossiê encomenda, e o resultado tem de refletir
     * isso sem reimportar a EFD.
     */
    it('localizar o XML que faltava muda o dossiê sem reimportar a EFD', async () => {
      const chave = accessKey(fornecedor, '000000015');
      await subir([nfeXml(fornecedor, cnpj, '000000016')]);
      await importar(abertura(cnpj), c100(chave), c170());

      expect((await dossie()).checks[0]!.status).toBe('sem_documento');

      await subir([nfeXml(fornecedor, cnpj, '000000015')]);

      expect((await dossie()).checks[0]!.status).toBe('lastreado');
    });
  });

  describe('saldo credor', () => {
    it('soma o saldo final por tributo', async () => {
      await importar(
        abertura(cnpj),
        r1100('012027', '5000,00'),
        r1100('022027', '3000,00').replace('|1100|', '|1500|'),
      );

      const d = await dossie();

      expect(d.summary.carriedBalanceCents).toEqual({ pis: 500_000, cofins: 300_000 });
    });

    it('saldo de competência coberta pode ser conferido', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj), r1100('062027'));

      const d = await dossie();

      expect(d.carried[0]!.withinCoverage).toBe(true);
      expect(d.carried[0]!.note).toMatch(/pode ser conferido/);
    });

    it('saldo antigo fora da cobertura não é confirmado nem negado', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(abertura(cnpj), r1100('012019'));

      const d = await dossie();

      expect(d.carried[0]!.withinCoverage).toBe(false);
      expect(d.carried[0]!.note).toMatch(/não tem como confirmá-lo nem negá-lo/);
      expect(d.summary['carriedWithinCoverageRatio']).toBe(0);
    });

    it('a fração coberta do saldo é razão em valor', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000015')]);
      await importar(
        abertura(cnpj),
        r1100('062027', '7500,00'),
        r1100('012019', '2500,00'),
      );

      const d = await dossie();

      expect(d.summary['carriedWithinCoverageRatio']).toBeCloseTo(0.75, 5);
    });
  });

  it('o dossiê de outro escritório não é acessível', async () => {
    await importar(abertura(cnpj));
    const outro = await createTenant(pool, 'Escritório vizinho');
    const intruso = await createMembership(pool, outro, 'owner');
    await createClient(pool, outro, cnpj, { regime: 'lucro_real' });

    const r = await call(
      'GET',
      `/v1/clients/${cnpj}/credit-dossier/${PERIODO}`,
      undefined,
      intruso,
    );

    expect(r.statusCode).toBe(404);
  });
});
