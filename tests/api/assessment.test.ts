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
const PERIODO = '2027-08';

function accessKey(issuer: string, numero = '000000015'): string {
  const base = `35` + `2708` + issuer + '55' + '001' + numero + '1' + '23456789';
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
  <ide><serie>001</serie><nNF>15</nNF><dhEmi>2027-08-15T10:30:00-03:00</dhEmi></ide>
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

describe.skipIf(!DATABASE_URL)('API — apuração dual', () => {
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

  const subir = async (xmls: string[]): Promise<void> => {
    const form = new FormData();
    xmls.forEach((xml, i) => form.append('files', Buffer.from(xml, 'utf8'), { filename: `n${i}.xml` }));
    const r = await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
      payload: form,
    });
    const body = r.json();
    if (body.rejected.length > 0) {
      throw new Error(`ingestao rejeitou: ${JSON.stringify(body.rejected)}`);
    }
  };

  const apurar = () => call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

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
    // `tax_rules` e dado normativo global, nao por tenant: sem limpar, a regra
    // inserida por um teste vale para o seguinte. Nenhum outro arquivo de teste
    // usa esta tabela.
    await pool.query('delete from tax_rules');

    tenantId = await createTenant(pool, 'Escritório da Apuração');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('projeção a partir dos documentos', () => {
    it('soma o tributo destacado nas saídas como débito', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);

      const r = await apurar();

      expect(r.statusCode).toBe(200);
      expect(r.json().totals.icms.debitsCents).toBe(18_000);
      expect(r.json().totals.cbs.debitsCents).toBe(9_210);
    });

    it('soma o tributo das entradas como crédito potencial', async () => {
      await subir([nfeXml(fornecedor, cnpj, '000000016', true)]);

      const r = await apurar();

      expect(r.json().totals.icms.debitsCents).toBe(0);
      expect(r.json().totals.icms.potentialCreditsCents).toBe(18_000);
    });

    /**
     * A decisão central da onda: sem regra de creditamento publicada, o devido
     * não é calculado. Um número fiscal errado é pior do que um ausente.
     */
    it('sem regra publicada, o devido vem null com o motivo', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);

      const body = (await apurar()).json();

      expect(body.totals.icms.dueCents).toBeNull();
      expect(body.total_due_cents).toBeNull();
      const motivo = body.not_computable.find((n: { subject: string }) => n.subject === 'icms');
      expect(motivo.reason).toBe('rule_not_published');
    });

    it('com regra publicada, calcula o devido e cita a regra', async () => {
      await pool.query(
        `insert into tax_rules (kind, regime, tax, value, valid_from, source)
         values ('credit_share', 'lucro_real', 'icms', 1.0, '2027-01-01', 'teste'),
                ('credit_share', 'lucro_real', 'pis',  1.0, '2027-01-01', 'teste'),
                ('credit_share', 'lucro_real', 'cbs',  1.0, '2027-01-01', 'teste'),
                ('credit_share', 'lucro_real', 'ibs_uf', 1.0, '2027-01-01', 'teste')`,
      );
      await subir([
        nfeXml(cnpj, fornecedor, '000000015', true),
        nfeXml(fornecedor, cnpj, '000000016', true),
      ]);

      const body = (await apurar()).json();

      expect(body.totals.icms.creditableCents).toBe(18_000);
      expect(body.totals.icms.dueCents).toBe(0);
      expect(body.totals.icms.ruleId).toBeTruthy();
      expect(body.total_due_cents).toBe(0);
    });

    /** Usar a regra de hoje faria janeiro ser recalculado com a regra de março. */
    it('usa a regra vigente na competência, não a de hoje', async () => {
      await pool.query(
        `insert into tax_rules (kind, regime, tax, value, valid_from, source)
         values ('credit_share', 'lucro_real', 'icms', 1.0, '2030-01-01', 'vigencia futura')`,
      );
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);

      expect((await apurar()).json().totals.icms.dueCents).toBeNull();
    });

    it('conta a prontidão para a reforma', async () => {
      await subir([
        nfeXml(cnpj, fornecedor, '000000015', true),
        nfeXml(cnpj, fornecedor, '000000017', false),
      ]);

      const body = (await apurar()).json();

      expect(body.coverage).toEqual({ itemsWithReformGroup: 1, itemsTotal: 2 });
      expect(
        body.not_computable.some((n: { reason: string }) => n.reason === 'missing_reform_group'),
      ).toBe(true);
    });

    it('competência sem documento apura zerada, sem erro', async () => {
      const body = (await apurar()).json();

      expect(body.documents_count).toBe(0);
      expect(body.total_due_cents).toBe(0);
    });

    it('a apuração move a competência de open para assessed', async () => {
      await apurar();

      const periodos = (await call('GET', `/v1/clients/${cnpj}/periods`)).json();
      expect(periodos[0].state).toBe('assessed');
    });
  });

  describe('memória de cálculo', () => {
    beforeEach(async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
    });

    it('persiste uma linha por item e por tributo', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}/trace`)).json();

      // icms, pis, cbs, ibs_uf
      expect(body.total).toBe(4);
      expect(body.items.every((l: { origin: string }) => l.origin === 'documento')).toBe(true);
    });

    it('cada linha aponta o documento, a base e a alíquota', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}/trace`)).json();
      const icms = body.items.find((l: { tax: string }) => l.tax === 'icms');

      expect(icms).toMatchObject({
        access_key: accessKey(cnpj, '000000015'),
        line: 1,
        cst: '00',
        base_cents: 100_000,
        rate: 18,
        amount_cents: 18_000,
        direction: 'outbound',
      });
    });

    it('filtra a memória por tributo', async () => {
      const body = (
        await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}/trace?tax=cbs`)
      ).json();

      expect(body.total).toBe(1);
      expect(body.items[0].amount_cents).toBe(9_210);
    });

    /** Reapurar substitui a memória: misturar duas execuções daria total que não fecha. */
    it('reapurar não duplica linhas', async () => {
      await apurar();

      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}/trace`)).json();
      expect(body.total).toBe(4);
    });
  });

  describe('ajuste manual', () => {
    beforeEach(async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
    });

    it('registra o ajuste com justificativa', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/adjustments`, {
        tax: 'icms',
        amount_cents: -5_000,
        reason: 'Nota de devolução recebida após o fechamento parcial',
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().action).toBe('assessment.adjusted');
    });

    it('o ajuste aparece na apuração sem sobrescrever os totais', async () => {
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/adjustments`, {
        tax: 'icms',
        amount_cents: -5_000,
        reason: 'Devolução',
      });

      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();

      expect(body.adjustments).toHaveLength(1);
      expect(body.adjustments[0]).toMatchObject({ tax: 'icms', amount_cents: -5_000 });
      // O total apurado continua o do documento: a diferença fica visível.
      expect(body.totals.icms.debitsCents).toBe(18_000);
    });

    it('exige justificativa', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/adjustments`, {
        tax: 'icms',
        amount_cents: -100,
        reason: '',
      });

      expect(r.statusCode).toBe(400);
    });

    it('404 para competência não apurada', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assessments/2027-09/adjustments`, {
        tax: 'icms',
        amount_cents: -100,
        reason: 'Motivo com tamanho suficiente',
      });

      expect(r.statusCode).toBe(404);
    });
  });

  describe('prontidão para confirmar', () => {
    /**
     * O `confirm` compara o hash enviado com o **atual** do log, e o hash que a
     * apuração guarda é o de quando ela foi calculada. Sem dizer se o guardado
     * ainda vale, a tela mandava um hash inevitavelmente recusado e o contador
     * lia `verification_mismatch` como defeito do sistema.
     */
    beforeEach(async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
    });

    it('recém-apurada está pronta para confirmar', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();

      expect(body.is_current).toBe(true);
    });

    it('depois de um ajuste, a apuração deixa de estar atual', async () => {
      const antes = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();

      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/adjustments`, {
        tax: 'icms',
        amount_cents: -5_000,
        reason: 'Devolução recebida depois da apuração',
      });

      const depois = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();

      expect(depois.is_current).toBe(false);
      // O hash guardado não muda: ele é o da apuração, não o do log.
      expect(depois.projection_hash).toBe(antes.projection_hash);
    });

    /**
     * Confirmar com o hash guardado, depois de um ajuste, é recusado — e é o
     * comportamento correto. `is_current` existe para a tela dizer isso antes
     * do clique, não para contorná-lo: o caminho é reprojetar e revisar.
     */
    it('o hash guardado é recusado depois do ajuste', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();

      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/adjustments`, {
        tax: 'icms',
        amount_cents: -5_000,
        reason: 'Devolução recebida depois da apuração',
      });

      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: body.projection_hash,
      });

      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ reason: 'verification_mismatch' });
    });

    /** A resposta não entrega o hash atual: entregá-lo convidaria a reenviá-lo. */
    it('não devolve o hash atual do log', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();

      expect(body).not.toHaveProperty('current_projection_hash');
    });
  });

  describe('confirmação da competência', () => {
    const conciliar = () =>
      pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'assessment.compared',
                             $3::text, $4::text, $5::char(7), now(), '0.5.0', '{}'::jsonb)`,
        [tenantId, cnpj, PERIODO, owner, PERIODO],
      );

    beforeEach(async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015', true)]);
      await apurar();
      // A máquina de estados exige reconciled antes de confirmed.
      await conciliar();
    });

    it('confirma quando o hash enviado é o atual', async () => {
      const hash = (await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`)).json();
      const atual = (
        await app.inject({
          method: 'POST',
          url: `/v1/clients/${cnpj}/verify`,
          headers: { authorization: `Bearer ${await tokenFor(owner)}` },
        })
      ).json();

      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: atual.stored_hash,
      });

      expect(hash.projection_hash).toBeTruthy();
      expect(r.statusCode).toBe(200);
      expect(r.json().state).toBe('confirmed');
      expect(r.json().message).toMatch(/retificação/);
    });

    /**
     * É o fechamento do laço de governança: confirmar com hash velho assinaria
     * um número que ninguém revisou.
     */
    it('recusa hash divergente com verification_mismatch', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: 'a'.repeat(64),
      });

      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ rejected: true, layer: 7, reason: 'verification_mismatch' });
      expect(r.json().message).toMatch(/recarregue a apuração/i);
    });

    it('recusa hash fora do formato', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: 'curto',
      });

      expect(r.statusCode).toBe(400);
    });

    /** INV-001: confirmada é terminal, e a camada 6 barra qualquer mutação. */
    it('competência confirmada recusa novo ajuste', async () => {
      const atual = (
        await app.inject({
          method: 'POST',
          url: `/v1/clients/${cnpj}/verify`,
          headers: { authorization: `Bearer ${await tokenFor(owner)}` },
        })
      ).json();
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: atual.stored_hash,
      });

      const r = await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/adjustments`, {
        tax: 'icms',
        amount_cents: -1,
        reason: 'tentativa depois do fechamento',
      });

      expect(r.statusCode).toBe(422);
      expect(r.json().reason).toBe('closed_period_violation');
    });

    it('competência confirmada recusa nova ingestão de documento', async () => {
      const atual = (
        await app.inject({
          method: 'POST',
          url: `/v1/clients/${cnpj}/verify`,
          headers: { authorization: `Bearer ${await tokenFor(owner)}` },
        })
      ).json();
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}/confirm`, {
        projection_hash: atual.stored_hash,
      });

      const form = new FormData();
      form.append('files', Buffer.from(nfeXml(cnpj, fornecedor, '000000099', true), 'utf8'), {
        filename: 'tarde.xml',
      });
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/documents`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(r.json().accepted).toHaveLength(0);
      expect(r.json().rejected[0].layer).toBe(6);
    });
  });

  it('404 ao ler competência não apurada, apontando o POST', async () => {
    const r = await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

    expect(r.statusCode).toBe(404);
    expect(r.json().message).toMatch(/POST na mesma rota/);
  });
});
