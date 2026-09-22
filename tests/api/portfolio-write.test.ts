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

describe.skipIf(!DATABASE_URL)('API — carteira e cofre de certificados', () => {
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

  describe('filtros da carteira', () => {
    /**
     * Os filtros da tela da carteira.
     *
     * Existem estes testes porque o contrato e a implementação divergiam:
     * `status` estava documentado como estado da competência e implementado
     * como status do CNPJ. Filtrar por `open` devolvia `200` com zero itens —
     * indistinguível de um escritório sem nenhum CNPJ cadastrado.
     */
    let outro: string;

    beforeEach(async () => {
      outro = randomCnpj();
      // Cadastro pela API, e não pelo helper de banco: `client.updated` só tem
      // efeito sobre uma projeção que já tem cliente, e a projeção só tem
      // cliente se houve `client.enrolled`. Semear a tabela direto criaria um
      // CNPJ que o log não explica — exatamente o que o produto promete não ter.
      await call('POST', '/v1/clients', owner, {
        cnpj,
        legal_name: 'Alfa Comercio LTDA',
        regime: 'lucro_real',
      });
      await call('POST', '/v1/clients', owner, {
        cnpj: outro,
        legal_name: 'Beta Servicos LTDA',
        regime: 'simples_hibrido',
      });
      await call('POST', `/v1/clients/${cnpj}/periods`, accountant, { period: '2027-01' });
    });

    const cnpjsDe = async (query: string): Promise<string[]> =>
      (await call('GET', `/v1/clients${query}`, owner))
        .json()
        .items.map((item: { cnpj: string }) => item.cnpj);

    it('ordena por razão social, e não pela ordem de cadastro', async () => {
      expect(await cnpjsDe('')).toEqual([cnpj, outro]);
    });

    it('filtra por regime', async () => {
      expect(await cnpjsDe('?regime=lucro_real')).toEqual([cnpj]);
      expect(await cnpjsDe('?regime=simples_hibrido')).toEqual([outro]);
    });

    it('filtra pelo estado da competência corrente', async () => {
      expect(await cnpjsDe('?state=open')).toEqual([cnpj]);
      // O CNPJ sem competência não casa com nenhum estado — inclusive não
      // aparece como se estivesse aberto.
      expect(await cnpjsDe('?state=confirmed')).toEqual([]);
    });

    it('filtra por status do CNPJ, que é a base da cobrança', async () => {
      await call('PATCH', `/v1/clients/${outro}`, owner, { status: 'inactive' });

      expect(await cnpjsDe('?status=active')).toEqual([cnpj]);
      expect(await cnpjsDe('?status=inactive')).toEqual([outro]);
    });

    it('devolve o status na listagem, para a tela não presumir ativo', async () => {
      const itens = (await call('GET', '/v1/clients', owner)).json().items;

      expect(itens).toEqual([
        expect.objectContaining({ cnpj, status: 'active', state: 'open' }),
        expect.objectContaining({ cnpj: outro, status: 'active', state: null }),
      ]);
    });

    /** Filtro inválido é 400: carteira vazia mentiria sobre o escritório. */
    it('recusa valor fora do enumerado em vez de devolver lista vazia', async () => {
      expect((await call('GET', '/v1/clients?regime=lucro_arbitrado', owner)).statusCode).toBe(400);
      expect((await call('GET', '/v1/clients?state=fechada', owner)).statusCode).toBe(400);
      expect((await call('GET', '/v1/clients?status=ativo', owner)).statusCode).toBe(400);
    });

    it('o total reflete o filtro, não a carteira inteira', async () => {
      const resposta = (await call('GET', '/v1/clients?regime=lucro_real', owner)).json();

      expect(resposta.total).toBe(1);
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

  describe('trilha do cliente', () => {
    beforeEach(async () => {
      await call('POST', '/v1/clients', owner, {
        cnpj,
        legal_name: 'Padaria do Bairro LTDA',
        regime: 'simples_hibrido',
      });
      await call('POST', `/v1/clients/${cnpj}/periods`, accountant, { period: '2027-01' });
      // Rejeitada: reabrir competência aberta é recusado na camada 4, e a
      // recusa também é um evento no log.
      await call('POST', `/v1/clients/${cnpj}/periods`, accountant, { period: '2027-01' });
    });

    it('resume a trilha por ação, com contagem e último evento', async () => {
      const resumo = (await call('GET', `/v1/clients/${cnpj}/events/summary`, accountant)).json();

      expect(resumo.total).toBe(3);
      expect(resumo.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'client.enrolled', count: 1, last_seq: 0 }),
          expect.objectContaining({ action: 'period.opened', count: 1, last_seq: 1 }),
          expect.objectContaining({ action: 'output.rejected', count: 1, last_seq: 2 }),
        ]),
      );
    });

    /**
     * O resumo lista só o que ocorreu.
     *
     * É o ponto do endpoint: o filtro da tela oferece estas ações e nada mais.
     * Oferecer o vocabulário inteiro faria o contador escolher um filtro que
     * devolve vazio sem saber se é porque não houve ou porque ele errou.
     */
    it('não lista ação que não ocorreu neste CNPJ', async () => {
      const resumo = (await call('GET', `/v1/clients/${cnpj}/events/summary`, accountant)).json();

      expect(resumo.actions.map((a: { action: string }) => a.action)).not.toContain(
        'assessment.confirmed',
      );
    });

    it('a trilha pagina por after_seq e mantém a ordem do log', async () => {
      const primeira = (
        await call('GET', `/v1/clients/${cnpj}/events?page_size=2`, accountant)
      ).json();
      expect(primeira.map((e: { event_seq: number }) => e.event_seq)).toEqual([0, 1]);

      const segunda = (
        await call('GET', `/v1/clients/${cnpj}/events?after_seq=1`, accountant)
      ).json();
      expect(segunda.map((e: { event_seq: number }) => e.event_seq)).toEqual([2]);
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

    /**
     * O cabeçalho do cliente lê o cofre, não o log.
     *
     * O log é append-only: "existe `certificate.stored`" continua verdadeiro
     * para sempre. Derivar dali faria o detalhe do cliente afirmar que há
     * certificado guardado depois de removido — e a coleta de DF-e falharia sem
     * ninguém entender por quê.
     */
    it('has_certificate acompanha o cofre, e volta a false depois de remover', async () => {
      const detalhe = async (): Promise<boolean> =>
        (await call('GET', `/v1/clients/${cnpj}`, owner)).json().has_certificate;

      expect(await detalhe()).toBe(false);

      await upload(owner);
      expect(await detalhe()).toBe(true);

      await call('DELETE', `/v1/clients/${cnpj}/certificate`, owner);
      expect(await detalhe()).toBe(false);
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

    /**
     * Conta os usos deste certificado, e não uma janela que ninguém calcula.
     *
     * O campo se chamava `usage_count_30d` e devolvia a contagem inteira da
     * projeção — nenhum filtro de 30 dias em lugar algum. O nome afirmava um
     * recorte que não existia.
     */
    it('devolve usage_count, e não uma janela de 30 dias inexistente', async () => {
      await upload(owner);

      const metadados = (await call('GET', `/v1/clients/${cnpj}/certificate`, owner)).json();

      expect(metadados).toMatchObject({ usage_count: 0 });
      expect(metadados).not.toHaveProperty('usage_count_30d');
    });

    describe('com usos registrados no log', () => {
      /**
       * Semeia `certificate.used` direto no log.
       *
       * Nenhum código de produção emite essa ação ainda — a coleta por
       * certificado (distribuição DF-e) não está implementada, então pela API
       * não há como produzi-la. O que se testa aqui é a rota de leitura, e para
       * isso o envelope semeado é suficiente: ele é exatamente o que o appender
       * gravaria.
       */
      const semearUsos = async (quantidade: number, primeiroSeq: number): Promise<void> => {
        await pool.query(
          `insert into events (
             tenant_id, cnpj, event_seq, event_id, action, task_id, actor,
             ts, schema_version, payload
           )
           select $1::uuid, $2::char(14), $3::bigint + i, gen_random_uuid(),
                  'certificate.used', $2::text,
                  case when i = 0 then $4::text else 'collector' end,
                  now() - (i || ' minutes')::interval, '0.4.0',
                  jsonb_build_object(
                    'purpose', 'dfe_distribution',
                    'target', 'https://www1.nfe.fazenda.gov.br',
                    'outcome', 'success',
                    'ip', '203.0.113.7'
                  )
             from generate_series(0, $5::int - 1) as i`,
          [tenantId, cnpj, primeiroSeq, owner, quantidade],
        );
      };

      /** O total contava a página. Trilha de uso do A1 com total errado não é trilha. */
      it('o total conta todos os usos, e não os 200 da página', async () => {
        await upload(owner);
        await semearUsos(205, 100);

        const resposta = (await call('GET', `/v1/clients/${cnpj}/certificate/usage`, owner)).json();

        expect(resposta.items).toHaveLength(200);
        expect(resposta.total).toBe(205);
      });

      /**
       * O log de uso existe para dizer quem agiu em nome do cliente perante o
       * Fisco. A rota afirmava `type: 'agent'` para todo uso, inclusive o
       * disparado por uma pessoa.
       */
      it('distingue uso por pessoa de uso por agente', async () => {
        await upload(owner);
        await semearUsos(2, 100);

        const itens = (await call('GET', `/v1/clients/${cnpj}/certificate/usage`, owner)).json()
          .items as { actor: { type: string; id: string } }[];

        const porPessoa = itens.find((item) => item.actor.id === owner);
        const porAgente = itens.find((item) => item.actor.id === 'collector');

        expect(porPessoa?.actor.type).toBe('user');
        expect(porAgente?.actor.type).toBe('agent');
      });
    });
  });
});
