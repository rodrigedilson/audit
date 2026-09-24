import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2026-01';

const reg = (...campos: string[]): string => `|${campos.join('|')}|`;

/** `0000` da EFD ICMS/IPI: DT_INI no campo 4 e CNPJ no 7. */
const abertura = (cnpj: string, versao = '020'): string =>
  reg(
    '0000',
    versao,
    '0',
    '01012026',
    '31012026',
    'EMPRESA DE TESTE LTDA',
    cnpj,
    '',
    'SP',
    '110042490114',
    '3550308',
    '',
    '',
    'A',
    '0',
  );

/** `0000` da EFD-Contribuições: DT_INI no campo 6 e CNPJ no 9. */
const aberturaContribuicoes = (cnpj: string): string =>
  reg(
    '0000',
    '006',
    '0',
    '',
    '',
    '01012026',
    '31012026',
    'EMPRESA DE TESTE LTDA',
    cnpj,
    'SP',
    '3550308',
    '',
    '00',
    '1',
  );

const c100 = (situacao = '00'): string =>
  reg(
    'C100', '1', '0', 'CLI1', '55', situacao, '1', '4321', '', '15012026', '15012026',
    '1000,00', '0', '0', '0', '1000,00', '9', '0', '0', '0', '1000,00', '180,00',
    '0', '0', '0', '0', '0', '0', '0',
  );

const c190 = (icms: string): string =>
  reg('C190', '00', '5102', '18,00', '1000,00', '1000,00', icms, '0', '0', '0', '0', 'OBS');

const e110 = (debitos: string, apurado: string, aRecolher: string): string =>
  reg(
    'E110', debitos, '0', '0', '0', '0', '0', '0', '0', '0', apurado, '0', aRecolher,
    '0', '0',
  );

interface Conciliacao {
  period: string;
  kind: string;
  layout_version: string;
  failedCount: number;
  notVerifiedCount: number;
  totalDifferenceCents: number;
  checks: {
    checkId: string;
    status: string;
    notVerifiedReason: string | null;
    declaredCents: number | null;
    expectedCents: number | null;
    differenceCents: number | null;
  }[];
}

describe.skipIf(!DATABASE_URL)('API — EFD ICMS/IPI', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
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

  const importar = async (
    ...linhas: string[]
  ): Promise<import('light-my-request').Response> =>
    app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/efd-icms-ipi`,
      headers: {
        authorization: `Bearer ${await tokenFor(owner)}`,
        'content-type': 'text/plain',
      },
      payload: linhas.join('\n'),
    });

  const conciliar = async (period = PERIODO): Promise<Conciliacao> =>
    (await call('GET', `/v1/clients/${cnpj}/icms-ipi-reconciliation/${period}`)).json();

  const pegar = (c: Conciliacao, id: string): Conciliacao['checks'][number] => {
    const achado = c.checks.find((x) => x.checkId === id);
    if (achado === undefined) throw new Error(`conferência '${id}' ausente`);
    return achado;
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
    tenantId = await createTenant(pool, 'Escritório do ICMS');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('importação', () => {
    it('importa e emite sped.imported', async () => {
      const r = await importar(abertura(cnpj), c100(), c190('180,00'), e110('180,00', '180,00', '180,00'));

      expect(r.statusCode).toBe(201);
      expect(r.json().period).toBe(PERIODO);
      expect(r.json().uf).toBe('SP');
      expect(r.json().documents_count).toBe(1);
      expect(r.json().has_icms_assessment).toBe(true);
      expect(r.json().has_ipi_assessment).toBe(false);

      const { rows } = await pool.query(
        `select 1 from events where tenant_id = $1::uuid and cnpj = $2::char(14)
           and action = 'sped.imported'`,
        [tenantId, cnpj],
      );
      expect(rows).toHaveLength(1);
    });

    it('recusa a escrituração de outro CNPJ', async () => {
      const r = await importar(abertura(randomCnpj()));

      expect(r.statusCode).toBe(422);
      expect(r.json().message ?? r.json().detail).toMatch(/acusam o cliente errado/);
    });

    it('recusa versão de leiaute não conferida', async () => {
      // `018` é de 2024; os guias conferidos são os de 2025 (019) e 2026 (020).
      const r = await importar(abertura(cnpj, '018'));

      expect(r.statusCode).toBe(422);
      expect(JSON.stringify(r.json())).toMatch(/não suportada/);
    });

    it('viewer não importa', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/efd-icms-ipi`,
        headers: {
          authorization: `Bearer ${await tokenFor(viewer)}`,
          'content-type': 'text/plain',
        },
        payload: abertura(cnpj),
      });

      expect(r.statusCode).toBe(403);
    });

    it('aceita multipart, guardando o nome do arquivo', async () => {
      const form = new FormData();
      form.append('file', Buffer.from(abertura(cnpj), 'latin1'), {
        filename: 'efd-icms-012026.txt',
      });

      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/efd-icms-ipi`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(r.statusCode).toBe(201);
      const { rows } = await pool.query<{ reference: string }>(
        `select reference from sped_files
          where tenant_id = $1::uuid and layout = 'icms_ipi'`,
        [tenantId],
      );
      expect(rows[0]!.reference).toBe('efd-icms-012026.txt');
    });

    it('convive com a EFD-Contribuições da mesma competência', async () => {
      // A `sped_files` era única por (tenant, cnpj, período). Sem a coluna que
      // diz qual escrituração é, importar uma apagaria a outra, e o dossiê de
      // saldo credor sumiria sem aviso.
      await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/sped`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/plain',
        },
        payload: aberturaContribuicoes(cnpj),
      });
      await importar(abertura(cnpj));

      const { rows } = await pool.query<{ layout: string }>(
        `select layout from sped_files
          where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)
          order by layout`,
        [tenantId, cnpj, PERIODO],
      );

      expect(rows.map((l) => l.layout)).toEqual(['contribuicoes', 'icms_ipi']);
    });

    it('a reimportação substitui, sem somar documentos', async () => {
      await importar(abertura(cnpj), c100(), c190('180,00'));
      await importar(abertura(cnpj), c100(), c190('180,00'));

      const { rows } = await pool.query<{ total: string }>(
        `select count(*)::text as total from efd_icms_documents
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );

      expect(rows[0]!.total).toBe('1');
    });
  });

  describe('conciliação', () => {
    it('devolve 404 quando não há escrituração importada', async () => {
      const r = await call('GET', `/v1/clients/${cnpj}/icms-ipi-reconciliation/${PERIODO}`);

      expect(r.statusCode).toBe(404);
      expect(JSON.stringify(r.json())).toMatch(/sem a escrituração não há o que conferir/);
    });

    it('confere a aritmética do E110 a partir do que foi gravado', async () => {
      await importar(abertura(cnpj), c100(), c190('180,00'), e110('180,00', '180,00', '180,00'));

      const conciliacao = await conciliar();

      expect(conciliacao.period).toBe(PERIODO);
      expect(conciliacao.layout_version).toBe('020');
      expect(pegar(conciliacao, 'e110-saldo-apurado').status).toBe('passed');
      expect(pegar(conciliacao, 'e110-icms-a-recolher').status).toBe('passed');
    });

    it('acusa a apuração que não fecha, com a diferença em centavos', async () => {
      await importar(abertura(cnpj), c100(), c190('180,00'), e110('180,00', '200,00', '200,00'));

      const check = pegar(await conciliar(), 'e110-saldo-apurado');

      expect(check.status).toBe('failed');
      expect(check.declaredCents).toBe(20_000);
      expect(check.expectedCents).toBe(18_000);
      expect(check.differenceCents).toBe(2_000);
    });

    it('confere as saídas contra o total de débitos declarado', async () => {
      await importar(abertura(cnpj), c100(), c190('180,00'), e110('180,00', '180,00', '180,00'));

      expect(pegar(await conciliar(), 'c190-vs-e110-debitos').status).toBe('passed');
    });

    it('acusa documento cancelado que ainda assim declara ICMS', async () => {
      await importar(abertura(cnpj), c100('02'), c190('180,00'), e110('0', '0', '0'));

      const check = pegar(await conciliar(), 'documento-sem-imposto-com-valor');

      expect(check.status).toBe('failed');
      expect(check.differenceCents).toBe(18_000);
    });

    /**
     * Arquivo como os reais: blocos abertos e fechados (C001, C990, D001, D990),
     * conta de energia e transporte além das NF-e. A regex antiga casava com o
     * encerramento de bloco, e a soma nunca era conferida.
     */
    describe('arquivo com energia, transporte e blocos abertos e fechados', () => {
      const campos = (registro: string, n: number, valores: Record<number, string>): string => {
        const lista = Array.from({ length: n }, (_, i) => (i === 0 ? registro : '0'));
        for (const [posicao, valor] of Object.entries(valores)) lista[Number(posicao) - 1] = valor;
        return reg(...lista);
      };
      const analitico = (registro: string, cfop: string, icms: string): string =>
        reg(registro, '000', cfop, '18,00', '300,00', '250,00', icms, '0', '0', '0', '');
      const arquivo = (): string[] => [
        abertura(cnpj),
        reg('C001', '0'),
        c100(),
        c190('180,00'),
        campos('C500', 27, { 2: '0', 3: '1', 4: 'CEMIG', 5: '06', 6: '00', 10: '777', 11: '10012026', 12: '10012026', 20: '45,00', 23: '' }),
        analitico('C590', '1253', '45,00'),
        reg('C990', '7'),
        reg('D001', '0'),
        campos('D100', 25, { 2: '0', 3: '1', 4: 'TRANSP', 5: '57', 6: '00', 9: '888', 10: '', 11: '12012026', 12: '12012026', 20: '12,00', 22: '', 23: '' }),
        analitico('D190', '1353', '12,00'),
        reg('D990', '4'),
        reg('E110', '180,00', '0', '0', '0', '57,00', '0', '0', '0', '0', '123,00', '0', '123,00', '0', '0'),
      ];

      it('soma C590 e D190 nos créditos, e confere os dois lados', async () => {
        const r = await importar(...arquivo());
        expect(r.statusCode).toBe(201);

        const conciliacao = await conciliar();

        expect(pegar(conciliacao, 'c190-vs-e110-debitos')).toMatchObject({ status: 'passed', expectedCents: 18_000 });
        expect(pegar(conciliacao, 'c190-vs-e110-creditos')).toMatchObject({ status: 'passed', expectedCents: 5_700 });
      });

      /** O que foi importado antes de o C590 ser lido tem a contagem e não tem a linha. */
      it('sem as linhas do C590 gravadas, os créditos voltam a não verificado', async () => {
        await importar(...arquivo());
        await pool.query("delete from efd_icms_documents where tenant_id = $1::uuid and record = 'C590'", [tenantId]);

        const creditos = pegar(await conciliar(), 'c190-vs-e110-creditos');

        expect(creditos.status).toBe('not_verified');
        expect(creditos.notVerifiedReason).toMatch(/C590/);
      });
    });

    it('não diz passed sobre o que não deu para conferir', async () => {
      await importar(abertura(cnpj), c100(), c190('180,00'));

      const conciliacao = await conciliar();
      const semApuracao = pegar(conciliacao, 'e110-saldo-apurado');

      expect(semApuracao.status).toBe('not_verified');
      expect(semApuracao.notVerifiedReason).toMatch(/não é o mesmo que apuração correta/);
      expect(conciliacao.notVerifiedCount).toBeGreaterThan(0);
    });
  });
});
