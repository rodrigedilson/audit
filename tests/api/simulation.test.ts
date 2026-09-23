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
const PERIODO = '2027-07';

function accessKey(issuer: string, numero: string): string {
  const base = '35' + '2707' + issuer + '55' + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

/** `recipientCnpj: null` simula venda a pessoa física — sem CNPJ na contraparte. */
function nfeXml(
  issuer: string,
  recipient: string | null,
  numero: string,
  totalReais = '1000.00',
): string {
  const key = accessKey(issuer, numero);
  const dest =
    recipient === null
      ? '<dest><xNome>CONSUMIDOR</xNome></dest>'
      : `<dest><CNPJ>${recipient}</CNPJ><xNome>CLIENTE PJ</xNome></dest>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>${Number(numero)}</nNF><dhEmi>2027-07-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${issuer}</CNPJ><xNome>EMITENTE</xNome></emit>
  ${dest}
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>${totalReais}</vUnCom><vProd>${totalReais}</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>${totalReais}</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
    </imposto>
  </det>
  <total><ICMSTot><vNF>${totalReais}</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

interface Resultado {
  id: string;
  winner: string | null;
  robustness: string;
  result: {
    base: { b2bShare: number; monthlyRevenueCents: number; documentsConsidered: number };
    outcomes: {
      regime: string;
      directTaxMonthlyCents: number;
      economicCostMonthlyCents: number;
      creditToB2BCustomersCents: number;
      workingCapitalExposureCents: number;
    }[];
    assumptions: { key: string; origin: string; source: string }[];
    notModeled: string[];
    sensitivity: unknown[];
    b2bBreakevenShare: number | null;
  };
}

describe.skipIf(!DATABASE_URL)('API — simulador de regime', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let cnpj: string;
  let clientePj: string;

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

  const simular = async (
    overrides?: Record<string, unknown>,
  ): Promise<import('light-my-request').Response> =>
    call('POST', `/v1/clients/${cnpj}/simulations`, {
      scenario: 'full_2033',
      base_from: PERIODO,
      base_to: PERIODO,
      ...(overrides === undefined ? {} : { overrides }),
    });

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
    tenantId = await createTenant(pool, 'Escritório do Simulador');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    clientePj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'simples_hibrido' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });
  });

  describe('metodologia', () => {
    /**
     * É a página que o simuleareforma tem e que o briefing cita como bom
     * exemplo: sem ela, o contador trata a saída como cálculo.
     */
    it('declara o que compara, o que não modela e que não escreve evento', async () => {
      const r = await call('GET', '/v1/simulations/methodology');

      expect(r.statusCode).toBe(200);
      expect(r.json().compares).toEqual([
        'simples_integrado',
        'simples_hibrido',
        'lucro_presumido',
      ]);
      expect(r.json().not_modeled.length).toBeGreaterThanOrEqual(10);
      expect(r.json().writes_fiscal_event).toBe(false);
      expect(r.json().reads_only).toBe(true);
    });

    it('explica por que MEI e Lucro Real ficam fora', async () => {
      const excluidos = (await call('GET', '/v1/simulations/methodology')).json().excluded;

      expect(excluidos.map((e: { regime: string }) => e.regime).sort()).toEqual([
        'lucro_real',
        'mei',
      ]);
      for (const excluido of excluidos) {
        expect(String(excluido.reason).trim().length).toBeGreaterThan(0);
      }
    });

    it('explica as duas teses do produto na própria metodologia', async () => {
      const explicacoes = (await call('GET', '/v1/simulations/methodology')).json().explains;

      expect(explicacoes.join(' ')).toMatch(/cliente PJ não toma crédito/);
      expect(explicacoes.join(' ')).toMatch(/capital de giro, não na DRE/);
    });
  });

  describe('base medida na carteira', () => {
    /**
     * A fração de receita contra PJ é o número que decide se a perda do crédito
     * repassável dói — e é o que o cliente não sabe responder de cabeça. Medi-la
     * nas notas é o que separa isto de uma planilha.
     */
    it('mede a fração de receita contra PJ nas notas de saída', async () => {
      await subir([
        nfeXml(cnpj, clientePj, '000000015'),
        nfeXml(cnpj, clientePj, '000000016'),
        nfeXml(cnpj, null, '000000017'),
        nfeXml(cnpj, null, '000000018'),
      ]);

      const r: Resultado = (await simular()).json();

      expect(r.result.base.b2bShare).toBeCloseTo(0.5, 5);
      expect(r.result.base.documentsConsidered).toBe(4);
    });

    it('mede a receita mensal a partir dos documentos', async () => {
      await subir([nfeXml(cnpj, clientePj, '000000015', '5000.00')]);

      const r: Resultado = (await simular()).json();

      expect(r.result.base.monthlyRevenueCents).toBe(500_000);
    });

    /**
     * Sem documento, qualquer número seria inventado. É a recusa que impede o
     * simulador de virar gerador de projeção vazia.
     */
    it('sem documento no período, recusa simular', async () => {
      const r = await simular();

      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/qualquer número seria inventado/);
    });

    it('nota de entrada não conta como receita', async () => {
      await subir([nfeXml(clientePj, cnpj, '000000015', '3000.00')]);

      const r: Resultado = (await simular()).json();

      expect(r.result.base.monthlyRevenueCents).toBe(0);
      expect(r.result.base.b2bShare).toBe(0);
    });

    it('recusa período invertido antes de consultar nada', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/simulations`, {
        scenario: 'full_2033',
        base_from: '2027-12',
        base_to: '2027-01',
      });

      expect(r.statusCode).toBe(422);
      expect(r.json().layer).toBe(2);
    });
  });

  describe('resultado', () => {
    beforeEach(async () => {
      // Metade da receita contra PJ: a faixa em que a escolha é interessante.
      await subir([
        nfeXml(cnpj, clientePj, '000000015', '5000.00'),
        nfeXml(cnpj, null, '000000016', '5000.00'),
        nfeXml(clientePj, cnpj, '000000017', '4000.00'),
      ]);
    });

    it('compara os três regimes com guia e custo econômico separados', async () => {
      const r: Resultado = (await simular()).json();

      expect(r.result.outcomes).toHaveLength(3);
      const integrado = r.result.outcomes.find((o) => o.regime === 'simples_integrado')!;
      expect(integrado.economicCostMonthlyCents).toBeGreaterThan(
        integrado.directTaxMonthlyCents,
      );
      expect(integrado.creditToB2BCustomersCents).toBe(0);
    });

    it('mostra a exposição de capital de giro do split payment', async () => {
      const r: Resultado = (await simular()).json();
      const presumido = r.result.outcomes.find((o) => o.regime === 'lucro_presumido')!;

      expect(presumido.workingCapitalExposureCents).toBeGreaterThan(0);
    });

    it('devolve o mapa de sensibilidade e o ponto de troca', async () => {
      const r: Resultado = (await simular()).json();

      expect(r.result.sensitivity).toHaveLength(30);
      expect(r.result.b2bBreakevenShare).not.toBeUndefined();
    });

    /**
     * A recusa central: com metade da receita contra PJ o vencedor muda dentro
     * da faixa de alíquotas, e apontar um seria dar recomendação com cara de
     * cálculo.
     */
    it('não aponta vencedor quando ele depende da alíquota', async () => {
      const r: Resultado = (await simular()).json();

      expect(r.robustness).toBe('sensitive');
      expect(r.winner).toBeNull();
    });

    it('aponta vencedor quando a escolha não depende da alíquota', async () => {
      const r: Resultado = (await simular({ simples_effective_rate: 60 })).json();

      expect(r.robustness).toBe('robust');
      expect(r.winner).toBe('lucro_presumido');
    });

    /**
     * A alíquota de referência não está publicada em texto oficial conferido, e
     * `tax_rules` nasce vazia. A premissa tem de sair marcada como informada.
     */
    it('a alíquota aparece como premissa informada, não como norma', async () => {
      const r: Resultado = (await simular()).json();
      const aliquota = r.result.assumptions.find((a) => a.key === 'ibs_cbs_rate')!;

      expect(aliquota.origin).toBe('provided');
      expect(aliquota.source).toMatch(/não está publicada/);
    });

    it('a fração de receita contra PJ aparece como medida', async () => {
      const r: Resultado = (await simular()).json();
      const b2b = r.result.assumptions.find((a) => a.key === 'b2b_share')!;

      expect(b2b.origin).toBe('measured');
    });

    it('substituir a fração medida é registrado como premissa informada', async () => {
      const r: Resultado = (await simular({ b2b_share: 0.9 })).json();

      expect(r.result.base.b2bShare).toBe(0.9);
      expect(r.result.assumptions.some((a) => a.key === 'b2b_share_override')).toBe(true);
    });

    it('toda premissa declara origem e fonte não vazia', async () => {
      const r: Resultado = (await simular()).json();

      expect(r.result.assumptions.length).toBeGreaterThanOrEqual(6);
      for (const premissa of r.result.assumptions) {
        expect(['published', 'measured', 'provided']).toContain(premissa.origin);
        expect(premissa.source.trim().length).toBeGreaterThan(0);
      }
    });

    it('devolve o que não é modelado junto do resultado', async () => {
      const r: Resultado = (await simular()).json();

      expect(r.result.notModeled.join(' ')).toMatch(/IRPJ e CSLL/);
      expect(r.result.notModeled.join(' ')).toMatch(/Fator R/);
    });
  });

  describe('governança', () => {
    beforeEach(async () => {
      await subir([nfeXml(cnpj, clientePj, '000000015', '5000.00')]);
    });

    /** Somente leitura: o simulador não escreve no log fiscal. */
    it('simular não acrescenta evento ao log', async () => {
      const antes = await pool.query<{ total: string }>(
        `select count(*)::text as total from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );

      await simular();
      await simular({ ibs_cbs_rate: 20 });

      const depois = await pool.query<{ total: string }>(
        `select count(*)::text as total from events
          where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );

      expect(depois.rows[0]!.total).toBe(antes.rows[0]!.total);
    });

    /**
     * A recomendação orienta a escolha de regime para toda a transição, e o
     * escritório precisa poder mostrar depois com que premissas aconselhou.
     */
    it('a simulação fica registrada com as premissas usadas', async () => {
      const criada: Resultado = (await simular({ ibs_cbs_rate: 22 })).json();

      const lista = (await call('GET', `/v1/clients/${cnpj}/simulations`)).json();

      expect(lista.total).toBe(1);
      expect(lista.simulations[0]!.id).toBe(criada.id);
      expect(
        lista.simulations[0]!.result.assumptions.find(
          (a: { key: string }) => a.key === 'ibs_cbs_rate',
        ).value,
      ).toBe(22);
    });

    it('lista as simulações da mais recente para a mais antiga', async () => {
      await simular({ ibs_cbs_rate: 20 });
      await simular({ ibs_cbs_rate: 30 });

      const lista = (await call('GET', `/v1/clients/${cnpj}/simulations`)).json();

      expect(lista.total).toBe(2);
      expect(
        lista.simulations[0]!.result.assumptions.find(
          (a: { key: string }) => a.key === 'ibs_cbs_rate',
        ).value,
      ).toBe(30);
    });

    it('MEI recebe recusa explicando por que não se aplica', async () => {
      const mei = randomCnpj();
      await createClient(pool, tenantId, mei, { regime: 'mei' });

      const r = await call('POST', `/v1/clients/${mei}/simulations`, {
        scenario: 'full_2033',
        base_from: PERIODO,
        base_to: PERIODO,
      });

      expect(r.statusCode).toBe(403);
      expect(r.json().message).toMatch(/limite de receita e regra própria/);
    });

    it('Lucro Real recebe recusa apontando o que não é modelado', async () => {
      const real = randomCnpj();
      await createClient(pool, tenantId, real, { regime: 'lucro_real' });

      const r = await call('POST', `/v1/clients/${real}/simulations`, {
        scenario: 'full_2033',
        base_from: PERIODO,
        base_to: PERIODO,
      });

      expect(r.statusCode).toBe(403);
      expect(r.json().message).toMatch(/não é modelado/);
    });

    it('a simulação de outro escritório não é visível', async () => {
      await simular();
      const outro = await createTenant(pool, 'Escritório vizinho');
      const intruso = await createMembership(pool, outro, 'owner');
      await createClient(pool, outro, cnpj, { regime: 'simples_hibrido' });

      const r = await call(
        'GET',
        `/v1/clients/${cnpj}/simulations`,
        undefined,
        intruso,
      );

      expect(r.json().total).toBe(0);
    });
  });
});
