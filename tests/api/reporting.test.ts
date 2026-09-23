import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { computeCheckDigit } from '../../src/fiscal/ingestion/access-key.js';
import { extractPdfText } from '../helpers/pdf.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-09';

function accessKey(issuer: string, numero: string): string {
  const base = '35' + '2709' + issuer + '55' + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

function nfeXml(issuer: string, recipient: string, numero: string, comReforma: boolean): string {
  const key = accessKey(issuer, numero);
  const reforma = comReforma
    ? `<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib>
         <gIBSCBS><vBC>1000.00</vBC>
           <gIBS><gIBSUF><pIBSUF>0.10</pIBSUF><vIBSUF>1.00</vIBSUF></gIBSUF></gIBS>
           <gCBS><pCBS>9.21</pCBS><vCBS>92.10</vCBS></gCBS>
         </gIBSCBS></IBSCBS>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>15</nNF><dhEmi>2027-09-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${issuer}</CNPJ><xNome>EMITENTE</xNome></emit>
  <dest><CNPJ>${recipient}</CNPJ><xNome>DESTINATARIO</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
      <PIS><PISAliq><CST>01</CST><vBC>1000.00</vBC><pPIS>1.65</pPIS><vPIS>16.50</vPIS></PISAliq></PIS>
      ${reforma}
    </imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

interface TrilhaDoCorpo {
  trailId: string;
  status: string;
  issuesCount: number;
  issues: { subject: string; message: string }[];
}

describe.skipIf(!DATABASE_URL)('API — trilhas de auditoria e Book de fechamento', () => {
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
  ): Promise<import('light-my-request').Response> => {
    const options: import('light-my-request').InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${await tokenFor(owner)}` },
    };
    if (payload !== undefined) options.payload = payload;
    return app.inject(options);
  };

  /** Devolve os rejeitados em vez de lançar: alguns testes querem a rejeição. */
  const subir = async (
    xmls: string[],
  ): Promise<{ accepted: unknown[]; rejected: { reason: string }[] }> => {
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
    return r.json();
  };

  const trilhas = async (): Promise<TrilhaDoCorpo[]> =>
    (await call('GET', `/v1/clients/${cnpj}/audit-trails/${PERIODO}`)).json().trails;

  const trilha = async (id: string): Promise<TrilhaDoCorpo> => {
    const encontrada = (await trilhas()).find((t) => t.trailId === id);
    if (!encontrada) throw new Error(`trilha ${id} não veio no relatório`);
    return encontrada;
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
    tenantId = await createTenant(pool, 'Escritório do Book');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();

    // `lucro_presumido` de propósito, e nada de mexer em `tax_rules`: a tabela
    // é dado normativo global, e o arquivo da apuração dual apaga e semeia
    // regras de `lucro_real` no seu próprio `beforeEach`. Como os arquivos
    // rodam em paralelo, escrever na mesma tabela fazia um quebrar o outro de
    // forma intermitente; separar por regime isola os dois sem serializar.
    await createClient(pool, tenantId, cnpj, {
      regime: 'lucro_presumido',
      legalName: 'CLIENTE LTDA',
    });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('catálogo de trilhas', () => {
    it('lista as trilhas sem exigir competência nem apuração', async () => {
      const r = await call('GET', '/v1/audit-trails');

      expect(r.statusCode).toBe(200);
      expect(r.json().total).toBeGreaterThanOrEqual(12);
      expect(r.json().trails.map((t: { trailId: string }) => t.trailId)).toContain(
        'cclasstrib_vs_cst',
      );
    });

    it('cada trilha declara a camada e a origem que a alimenta', async () => {
      const catalogo = (await call('GET', '/v1/audit-trails')).json().trails;

      for (const t of catalogo) {
        expect(t.source).toMatch(/output_rejected|item_classification|assessment|period_state/);
        expect(t.matches.length).toBeGreaterThan(0);
      }
    });
  });

  describe('resultado por competência', () => {
    it('competência aberta reprova a trilha de confirmação', async () => {
      expect((await trilha('competencia_nao_confirmada')).status).toBe('failed');
    });

    /**
     * A rejeição de ingestão tem de chegar ao Book da competência certa. A
     * competência vem da chave de acesso, porque um documento recusado pode não
     * ter data de emissão legível.
     */
    it('documento duplicado aparece na trilha da competência da chave', async () => {
      const xml = nfeXml(cnpj, fornecedor, '000000015', true);
      await subir([xml]);
      const segundo = await subir([xml]);

      expect(segundo.rejected[0]!.reason).toBe('duplicate_document');

      const t = await trilha('documento_duplicado');
      expect(t.issuesCount).toBe(1);
      expect(t.status).not.toBe('passed');
    });

    it('nota sem grupo IBS/CBS aparece na trilha de prontidão', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', false)]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      const t = await trilha('item_sem_grupo_ub');
      expect(t.issuesCount).toBe(1);
      expect(t.issues[0]!.message).toContain('IBS/CBS');
    });

    it('sem regra publicada, a trilha de regra reporta o tributo', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      const t = await trilha('regra_nao_publicada');
      expect(t.issuesCount).toBeGreaterThan(0);
      expect(t.issues.map((i) => i.subject)).toContain('icms');
    });

    /**
     * O ponto de honestidade da onda: sem tabela oficial carregada as trilhas de
     * código não conferiram nada, e reportar `passed` afirmaria uma verificação
     * que não aconteceu.
     */
    it('trilha de código fica not_applicable quando a tabela oficial está vazia', async () => {
      const { rows } = await pool.query<{ total: string }>(
        'select count(*)::text as total from fiscal_codes',
      );
      const carregadas = Number(rows[0]!.total) > 0;

      const t = await trilha('cclasstrib_vs_cst');
      expect(t.status).toBe(carregadas ? 'passed' : 'not_applicable');
    });

    it('o relatório declara se as tabelas de referência estavam carregadas', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/audit-trails/${PERIODO}`)).json();

      expect(typeof body.reference_tables_loaded).toBe('boolean');
      expect(body.summary.failed + body.summary.warning).toBeGreaterThan(0);
    });
  });

  describe('Book de fechamento', () => {
    const apurar = () => call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

    /**
     * O white label é entitlement de plano — Lucro Presumido para cima —, e
     * estava documentado sem ser verificado em lugar nenhum. A tela seria a
     * única tranca, e qualquer cliente HTTP pediria `white_label: true` num
     * CNPJ de MEI.
     */
    it('recusa white label em regime cujo plano não o inclui', async () => {
      // A fixture nasce em lucro_presumido, que tem o entitlement.
      await pool.query(
        `update clients set regime = 'simples_hibrido'
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();

      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {
        white_label: true,
      });

      expect(r.statusCode).toBe(403);
      expect(r.json().message).toMatch(/Lucro Presumido/);
    });

    it('gera com white label quando o regime do CNPJ o inclui', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();

      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {
        white_label: true,
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().white_label).toBe(true);
    });

    /** Sem pedir white label, qualquer regime gera o Book normalmente. */
    it('gera sem white label em qualquer regime', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();

      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {});

      expect(r.statusCode).toBe(201);
      expect(r.json().white_label).toBe(false);
    });

    it('sem apuração, recusa gerar o Book com camada e motivo', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {});

      expect(r.statusCode).toBe(422);
      expect(r.json().layer).toBe(4);
    });

    it('gera um PDF com páginas, hash da projeção e SHA-256 do arquivo', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      const apuracao = (await apurar()).json();

      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {});

      expect(r.statusCode).toBe(201);
      const book = r.json();
      expect(book.pages).toBeGreaterThanOrEqual(1);
      expect(book.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(book.projection_hash).toBe(apuracao.projection_hash);
      expect(book.event_seq).toBeGreaterThan(0);
    });

    it('o download devolve os mesmos bytes, com o SHA-256 no cabeçalho', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
      const book = (await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {})).json();

      const r = await app.inject({
        method: 'GET',
        url: `/v1/clients/${cnpj}/books/${PERIODO}/${book.id}/download`,
        headers: { authorization: `Bearer ${await tokenFor(owner)}` },
      });

      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(r.headers['x-book-sha256']).toBe(book.pdf_sha256);
      expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(r.rawPayload.length).toBe(book.pdf_bytes);

      // Fecha o laço: o hash impresso no rodapé é o da apuração deste CNPJ,
      // e não um valor qualquer que o renderizador recebeu.
      const texto = extractPdfText(r.rawPayload);
      expect(texto).toContain(book.projection_hash);
      expect(texto).toContain('CLIENTE LTDA');
      expect(texto).toContain(`Competência ${PERIODO}`);
    });

    /**
     * Os bytes são guardados, não regerados. Se o Book fosse remontado no
     * download, mudar uma regra produziria outro arquivo com o mesmo id — e o
     * contador perderia a capacidade de mostrar o que enviou.
     */
    it('o download não muda depois de a apuração ser refeita', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
      const book = (await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {})).json();

      // Mais um documento muda os totais e, com eles, o PDF que uma regeração
      // produziria.
      await subir([nfeXml(cnpj, fornecedor, '000000016', true)]);
      const refeita = (await apurar()).json();
      expect(refeita.totals.icms.debitsCents).toBe(36_000);

      const r = await app.inject({
        method: 'GET',
        url: `/v1/clients/${cnpj}/books/${PERIODO}/${book.id}/download`,
        headers: { authorization: `Bearer ${await tokenFor(owner)}` },
      });

      expect(r.headers['x-book-sha256']).toBe(book.pdf_sha256);
    });

    it('a versão do dono da empresa sai sem a memória de cálculo', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();

      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {
        audience: 'business_owner',
        white_label: true,
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().include_trace).toBe(false);
      expect(r.json().white_label).toBe(true);
    });

    it('lista os Books da competência do mais recente para o mais antigo', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
      await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, { audience: 'accountant' });
      await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, { audience: 'business_owner' });

      const body = (await call('GET', `/v1/clients/${cnpj}/books/${PERIODO}`)).json();

      expect(body.total).toBe(2);
      expect(body.books[0]!.audience).toBe('business_owner');
    });

    /**
     * Gerar o Book de uma competência confirmada é justamente o caso de uso —
     * a camada 6 não pode tratá-lo como mutação.
     */
    it('gera o Book de uma competência já confirmada', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();

      // A máquina de estados exige `reconciled` antes de `confirmed`, e a
      // contra-apuração que o produz é da Onda 8: aqui o evento é gravado
      // direto no log, como no teste da apuração.
      await pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'assessment.compared',
                             $3::text, $4::text, $5::char(7), now(), '0.5.0', '{}'::jsonb)`,
        [tenantId, cnpj, PERIODO, owner, PERIODO],
      );

      const atual = (await call('POST', `/v1/clients/${cnpj}/verify`)).json();
      const confirmacao = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: atual.stored_hash,
      });
      expect(confirmacao.statusCode).toBe(200);

      const r = await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {});

      expect(r.statusCode).toBe(201);
      expect(r.json().trails_summary).toBeDefined();
    });

    it('o Book de outro escritório não é baixável nem existindo o id', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
      const book = (await call('POST', `/v1/clients/${cnpj}/books/${PERIODO}`, {})).json();

      const outroTenant = await createTenant(pool, 'Escritório vizinho');
      const intruso = await createMembership(pool, outroTenant, 'owner');
      await createClient(pool, outroTenant, cnpj, { regime: 'lucro_real' });

      const r = await app.inject({
        method: 'GET',
        url: `/v1/clients/${cnpj}/books/${PERIODO}/${book.id}/download`,
        headers: { authorization: `Bearer ${await tokenFor(intruso)}` },
      });

      expect(r.statusCode).toBe(404);
    });
  });
});
