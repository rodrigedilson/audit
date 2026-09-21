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
const PERIODO = '2027-10';
const CABECALHO = 'chave_acesso;item;tributo;sentido;base;aliquota;valor';

function accessKey(issuer: string, numero: string): string {
  const base = '35' + '2710' + issuer + '55' + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

function nfeXml(issuer: string, recipient: string, numero: string): string {
  const key = accessKey(issuer, numero);

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>15</nNF><dhEmi>2027-10-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${issuer}</CNPJ><xNome>EMITENTE</xNome></emit>
  <dest><CNPJ>${recipient}</CNPJ><xNome>DESTINATARIO</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
    </imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

interface DivergenciaDoCorpo {
  scope: string;
  subject: string;
  probableCause: string;
  severity: string;
  differenceCents: number;
}

describe.skipIf(!DATABASE_URL)('API — contra-apuração e calendário', () => {
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

  const apurar = () => call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

  /** Sobe a proposta como CSV cru, que é o caminho do `curl --data-binary`. */
  const proposta = async (
    ...linhas: string[]
  ): Promise<import('light-my-request').Response> =>
    app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/fisco-assessments/${PERIODO}`,
      headers: {
        authorization: `Bearer ${await tokenFor(owner)}`,
        'content-type': 'text/csv',
      },
      payload: linhas.join('\n'),
    });

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
    tenantId = await createTenant(pool, 'Escritório da Contra-apuração');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();

    // `simples_integrado` isola este arquivo do da apuração dual e do Book, que
    // usam `lucro_real` e `lucro_presumido`: `tax_rules` é dado normativo global
    // e os arquivos rodam em paralelo.
    await createClient(pool, tenantId, cnpj, { regime: 'simples_integrado' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('upload da proposta', () => {
    /**
     * Sem a nossa apuração não há o que comparar, e registrar a proposta sozinha
     * daria a impressão de conferência que não aconteceu.
     */
    it('recusa a proposta quando a competência não foi apurada', async () => {
      const r = await proposta(CABECALHO, `${accessKey(cnpj, '000000015')};1;icms;S;1000,00;18;180,00`);

      expect(r.statusCode).toBe(422);
      expect(r.json().layer).toBe(4);
      expect(r.json().message).toMatch(/não foi apurada/);
    });

    it('registra a proposta e emite assessment.compared', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();

      const r = await proposta(
        CABECALHO,
        `${accessKey(cnpj, '000000015')};1;icms;S;1000,00;18;180,00`,
      );

      expect(r.statusCode).toBe(201);
      expect(r.json().line_level).toBe(true);
      expect(r.json().event_seq).toBeGreaterThan(0);

      const { rows } = await pool.query(
        `select action from events
          where tenant_id = $1::uuid and cnpj = $2::char(14) and action = 'assessment.compared'`,
        [tenantId, cnpj],
      );
      expect(rows).toHaveLength(1);
    });

    it('proposta idêntica à nossa apuração não gera divergência', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();

      const r = await proposta(
        CABECALHO,
        `${accessKey(cnpj, '000000015')};1;icms;S;1000,00;18;180,00`,
      );

      expect(r.json().divergences).toHaveLength(0);
      expect(r.json().summary.linesCompared).toBe(1);
    });

    it('recusa o arquivo com cabeçalho irreconhecível na camada 1', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();

      const r = await proposta('foo;bar', '1;2');

      expect(r.statusCode).toBe(422);
      expect(r.json().layer).toBe(1);
    });

    it('aceita a proposta por multipart também', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();

      const form = new FormData();
      form.append(
        'file',
        Buffer.from(
          [CABECALHO, `${accessKey(cnpj, '000000015')};1;icms;S;1000,00;18;180,00`].join('\n'),
          'utf8',
        ),
        { filename: 'proposta-do-fisco.csv' },
      );

      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/fisco-assessments/${PERIODO}`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
        payload: form,
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().reference).toBe('proposta-do-fisco.csv');
    });

    /**
     * Manter as divergências da proposta antiga misturadas com as da nova daria
     * dois números para a mesma competência, e nenhum deles defensável.
     */
    it('proposta nova substitui a anterior por inteiro', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();
      const chave = accessKey(cnpj, '000000015');

      await proposta(CABECALHO, `${chave};1;icms;S;1000,00;12;120,00`);
      const segunda = await proposta(CABECALHO, `${chave};1;icms;S;1000,00;18;180,00`);

      expect(segunda.json().divergences).toHaveLength(0);
      const { rows } = await pool.query(
        `select count(*)::int as total from assessment_divergences
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );
      expect(rows[0]!.total).toBe(0);
    });
  });

  describe('divergências apuradas', () => {
    const comApuracao = async (): Promise<string> => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();
      return accessKey(cnpj, '000000015');
    };

    it('alíquota diferente é nomeada como tal, com a diferença em centavos', async () => {
      const chave = await comApuracao();

      const r = await proposta(CABECALHO, `${chave};1;icms;S;1000,00;12;120,00`);

      const divergencias: DivergenciaDoCorpo[] = r.json().divergences;
      expect(divergencias[0]!.probableCause).toBe('aliquota_divergente');
      expect(divergencias[0]!.differenceCents).toBe(-6_000);
    });

    /**
     * O achado central do diferencial: o Fisco tem uma saída que nunca entrou na
     * nossa escrita. É débito que será cobrado, e o silêncio o confirma.
     */
    it('saída que só o Fisco tem é exposição crítica', async () => {
      const chave = await comApuracao();
      const outra = accessKey(cnpj, '000000099');

      const r = await proposta(
        CABECALHO,
        `${chave};1;icms;S;1000,00;18;180,00`,
        `${outra};1;icms;S;5000,00;18;900,00`,
      );

      const divergencias: DivergenciaDoCorpo[] = r.json().divergences;
      expect(divergencias[0]!.probableCause).toBe('debito_nao_escriturado');
      expect(divergencias[0]!.severity).toBe('critical');
      expect(divergencias[0]!.scope).toBe('documento');
      expect(r.json().summary.exposureCents).toBe(90_000);
    });

    it('exposição e perda de crédito não se cancelam no resumo', async () => {
      const chave = await comApuracao();

      const r = await proposta(
        CABECALHO,
        `${chave};1;icms;S;1000,00;18;180,00`,
        `${accessKey(cnpj, '000000098')};1;icms;S;1000,00;18;180,00`,
        `${accessKey(fornecedor, '000000097')};1;icms;E;1000,00;18;180,00`,
      );

      expect(r.json().summary.exposureCents).toBe(18_000);
      expect(r.json().summary.creditLossCents).toBe(18_000);
    });

    it('as divergências gravadas voltam no GET com o mesmo resumo', async () => {
      const chave = await comApuracao();
      const enviada = await proposta(CABECALHO, `${chave};1;icms;S;1000,00;12;120,00`);

      const lida = await call('GET', `/v1/clients/${cnpj}/fisco-assessments/${PERIODO}`);

      expect(lida.statusCode).toBe(200);
      expect(lida.json().divergences).toHaveLength(enviada.json().divergences.length);
      expect(lida.json().summary.linesCompared).toBe(enviada.json().summary.linesCompared);
      expect(lida.json().reference).toContain('text/csv');
    });

    it('sem proposta registrada, o GET é 404 e diz o que fazer', async () => {
      const r = await call('GET', `/v1/clients/${cnpj}/fisco-assessments/${PERIODO}`);

      expect(r.statusCode).toBe(404);
      expect(r.json().message).toMatch(/POST na mesma rota/);
    });

    /**
     * Sem detalhe a comparação nota a nota não acontece. Reportar zero
     * divergências de item seria lido como "confere".
     */
    it('proposta só de totais declara que não houve comparação nota a nota', async () => {
      await comApuracao();

      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/fisco-assessments/${PERIODO}`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/csv',
        },
        payload: 'tributo;valor\nicms;180,00',
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().line_level).toBe(false);
      expect(r.json().summary.lineLevel).toBe(false);
      expect(r.json().summary.linesCompared).toBe(0);
    });

    it('linha ruim é devolvida no rejected sem derrubar as boas', async () => {
      const chave = await comApuracao();

      const r = await proposta(
        CABECALHO,
        `${chave};1;icms;S;1000,00;18;180,00`,
        `${chave};2;icms;?;1000,00;18;180,00`,
      );

      expect(r.statusCode).toBe(201);
      expect(r.json().lines_count).toBe(1);
      expect(r.json().rejected).toHaveLength(1);
      expect(r.json().rejected[0]!.reason).toMatch(/Sentido/);
    });
  });

  describe('calendário da carteira', () => {
    /**
     * `deadline_rules` nasce vazia de propósito. Lista vazia de prazo não é
     * "nada a vencer": é "nada carregado", e a API tem de dizer isso.
     *
     * A expectativa é derivada da tabela, não fixada em `false`: `deadline_rules`
     * é dado normativo global e o arquivo de teste do doctor semeia uma regra
     * nele. Fixar `false` aqui faria os dois arquivos brigarem em paralelo.
     */
    it('declara se algum prazo normativo está carregado', async () => {
      const { rows } = await pool.query<{ total: string }>(
        `select count(*)::text as total from deadline_rules
          where active and nature = 'normativo'`,
      );

      const r = await call('GET', '/v1/deadlines');

      expect(r.statusCode).toBe(200);
      expect(r.json().normative_rules_loaded).toBe(Number(rows[0]!.total) > 0);
    });

    it('competência do mês corrente não gera pendência', async () => {
      const corrente = new Date().toISOString().slice(0, 7);
      await call('POST', `/v1/clients/${cnpj}/periods`, { period: corrente });

      const pendencias = (await call('GET', '/v1/deadlines')).json().pendencies;

      expect(pendencias.filter((p: { period: string }) => p.period === corrente)).toHaveLength(0);
    });

    it('competência encerrada e aberta aparece como não apurada', async () => {
      // `PERIODO` é de 2027 e serve à comparação; a pendência de mês encerrado
      // precisa de uma competência que já terminou de verdade.
      const passada = '2026-01';
      await call('POST', `/v1/clients/${cnpj}/periods`, { period: passada });

      const pendencias = (await call('GET', '/v1/deadlines')).json().pendencies;

      const minha = pendencias.find((p: { period: string }) => p.period === passada);
      expect(minha.kind).toBe('competencia_nao_apurada');
      expect(minha.daysOpen).toBeGreaterThan(0);
      expect(minha.severity).toBe('critical');
    });

    it('proposta com divergência crítica aparece como falta de resposta', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await apurar();
      await proposta(
        CABECALHO,
        `${accessKey(cnpj, '000000015')};1;icms;S;1000,00;18;180,00`,
        `${accessKey(cnpj, '000000099')};1;icms;S;5000,00;18;900,00`,
      );

      const pendencias = (await call('GET', '/v1/deadlines')).json().pendencies;

      const sem = pendencias.find(
        (p: { kind: string; cnpj: string }) =>
          p.kind === 'proposta_do_fisco_sem_resposta' && p.cnpj === cnpj,
      );
      expect(sem.severity).toBe('critical');
      expect(sem.message).toMatch(/silêncio do contribuinte/);
    });

    it('o prazo do certificado A1 entra como fato, sem base legal', async () => {
      await pool.query(
        `insert into certificates (
           tenant_id, cnpj, subject, issuer, serial, valid_from, valid_to,
           encrypted_pfx, fingerprint, stored_by
         ) values ($1::uuid, $2::char(14), 'CN=TESTE', 'AC TESTE', 'FF',
                   now() - interval '1 year', now() + interval '10 days',
                   'cifrado-de-teste', repeat('a', 64), $3::uuid)`,
        [tenantId, cnpj, owner],
      );

      const prazos = (await call('GET', '/v1/deadlines')).json().deadlines;

      const certificado = prazos.find(
        (d: { kind: string; cnpj: string }) =>
          d.kind === 'certificado_a1_vencendo' && d.cnpj === cnpj,
      );
      expect(certificado.nature).toBe('fato');
      expect(certificado.legal_basis).toBeNull();
      expect(certificado.days_left).toBeLessThanOrEqual(10);
    });

    it('reprocessar o calendário não duplica prazo', async () => {
      await pool.query(
        `insert into certificates (
           tenant_id, cnpj, subject, issuer, serial, valid_from, valid_to,
           encrypted_pfx, fingerprint, stored_by
         ) values ($1::uuid, $2::char(14), 'CN=TESTE', 'AC TESTE', 'FF',
                   now() - interval '1 year', now() + interval '10 days',
                   'cifrado-de-teste', repeat('a', 64), $3::uuid)`,
        [tenantId, cnpj, owner],
      );

      await call('GET', '/v1/deadlines');
      await call('GET', '/v1/deadlines');

      const { rows } = await pool.query(
        `select count(*)::int as total from deadlines
          where tenant_id = $1::uuid and kind = 'certificado_a1_vencendo'`,
        [tenantId],
      );
      expect(rows[0]!.total).toBe(1);
    });

    it('o horizonte recorta o que aparece', async () => {
      const r = await call('GET', '/v1/deadlines?horizon_days=1');

      expect(r.json().horizon_days).toBe(1);
    });

    it('a carteira de outro escritório não vaza no calendário', async () => {
      const outro = await createTenant(pool, 'Escritório vizinho');
      const intruso = await createMembership(pool, outro, 'owner');

      const r = await app.inject({
        method: 'GET',
        url: '/v1/deadlines',
        headers: { authorization: `Bearer ${await tokenFor(intruso)}` },
      });

      expect(r.json().pendencies).toHaveLength(0);
      expect(r.json().deadlines).toHaveLength(0);
    });
  });
});
