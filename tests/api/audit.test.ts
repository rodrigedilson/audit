import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-03';

describe.skipIf(!DATABASE_URL)('API — auditoria contínua', () => {
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

  /** Abre a competência: sem ela o pipeline barra na camada 4. */
  const abrirCompetencia = async (): Promise<void> => {
    const r = await call('POST', `/v1/clients/${cnpj}/periods`, owner, { period: PERIODO });
    expect(r.statusCode).toBe(201);
  };

  /**
   * Um documento de entrada com chave que NÃO fecha o dígito verificador — é o
   * que a verificação 1 reprova.
   */
  const documentoComChaveQuebrada = async (): Promise<string> => {
    const chave = `3527031122233300018155001000000001100000009`.padEnd(43, '0') + '9';
    await pool.query(
      `insert into documents
         (tenant_id, cnpj, access_key, model, direction, issued_at, period,
          issuer_cnpj, counterparty_cnpj, total_cents, event_seq)
       values ($1::uuid, $2::char(14), $3::char(44), 'nfe', 'inbound',
               '2027-03-10T12:00:00Z', $4::char(7), $5::char(14), $2::char(14), 250000, 0)
       on conflict do nothing`,
      [tenantId, cnpj, chave.slice(0, 44), PERIODO, '11222333000181'],
    );
    return chave.slice(0, 44);
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
    tenantId = await createTenant(pool, 'Escritório da Auditoria');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj);

    /**
     * `evaluation_criteria` é global — não tem `tenant_id`, porque uma norma
     * não pertence a um escritório. O isolamento por tenant que o resto da
     * suíte usa não vale aqui, então cada teste devolve a tabela ao estado de
     * nascimento: não conferida. Sem isso, um teste que confere critérios faria
     * o seguinte ver a execução concluir.
     */
    await pool.query(
      `update evaluation_criteria
          set verified = false, source_ref = null, verified_at = null`,
    );
  });

  describe('catálogo de trilhas', () => {
    it('lista as trilhas e declara quantas estão inativas', async () => {
      const r = await call('GET', '/v1/audit-procedures', owner);
      const corpo = r.json();

      expect(r.statusCode).toBe(200);
      expect(corpo.procedures.length).toBeGreaterThan(0);
      // Declarado, não escondido: o escritório vê o que ainda não é conferido.
      expect(corpo.inactive_count).toBeGreaterThan(0);
    });

    it('toda trilha roda em censo e cita um critério', async () => {
      const corpo = (await call('GET', '/v1/audit-procedures', owner)).json();

      for (const p of corpo.procedures) {
        expect(p.sampling_technique).toBe('censo');
        expect(String(p.criterion_id).length).toBeGreaterThan(0);
      }
    });
  });

  describe('execução', () => {
    /**
     * O critério nasce não conferido, então mesmo com achado a execução sai
     * inconclusiva — e é isso que impede o produto de afirmar contra uma norma
     * que ninguém abriu.
     */
    it('com critério não conferido, a execução é inconclusiva e diz por quê', async () => {
      await abrirCompetencia();
      await documentoComChaveQuebrada();

      const r = await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);
      const corpo = r.json();

      expect(r.statusCode).toBe(207);
      expect(corpo.executions.length).toBeGreaterThan(0);
      for (const e of corpo.executions) {
        expect(e.criterion_verified).toBe(false);
        expect(e.status).toBe('inconclusive');
        expect(String(e.inconclusive_reason).length).toBeGreaterThan(0);
      }
    });

    it('examina a população inteira — censo, não amostra', async () => {
      await abrirCompetencia();
      await documentoComChaveQuebrada();

      const corpo = (
        await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner)
      ).json();
      const comPopulacao = corpo.executions.filter((e: { population_size: number }) => e.population_size > 0);

      for (const e of comPopulacao) {
        expect(e.examined_count).toBe(e.population_size);
      }
    });

    it('viewer não executa', async () => {
      await abrirCompetencia();

      const r = await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, viewer);

      expect(r.statusCode).toBe(403);
    });

    it('sem token não responde', async () => {
      const r = await app.inject({
        method: 'GET',
        url: `/v1/clients/${cnpj}/audit/${PERIODO}/findings`,
      });

      expect(r.statusCode).toBe(401);
    });

    /** CNPJ de outro escritório é 404, e não 403 — ADR-002. */
    it('CNPJ fora da carteira é 404', async () => {
      const r = await call('GET', `/v1/clients/${randomCnpj()}/audit/${PERIODO}/findings`, owner);

      expect(r.statusCode).toBe(404);
    });
  });

  describe('revisão e estorno', () => {
    const conferirCriterios = async (): Promise<void> => {
      await pool.query(
        `update evaluation_criteria
            set verified = true, source_ref = 'conferido no teste', verified_at = now()`,
      );
    };

    const primeiroAchado = async (): Promise<string | null> => {
      const corpo = (await call('GET', `/v1/clients/${cnpj}/audit/${PERIODO}/findings`, owner)).json();
      return corpo.findings[0]?.finding_id ?? null;
    };

    it('recusar um achado sem justificativa é rejeitado', async () => {
      await conferirCriterios();
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);

      const id = await primeiroAchado();
      if (id === null) {
        return;
      }

      const r = await call('POST', `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id)}/review`, owner, {
        status: 'rejected',
      });

      // 422, e não 400: recusar sem motivo passa no schema e é barrado pela
      // regra de mérito, que é onde ela pertence.
      expect(r.statusCode).toBe(422);
    });

    /**
     * O portão central: o sistema propõe e não estorna. Um achado ainda não
     * aceito pelo contador devolve 422 com a lista de impedimentos, para a tela
     * dizer tudo que falta de uma vez.
     */
    it('estorno de achado não revisado devolve 422 com os impedimentos', async () => {
      await conferirCriterios();
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);

      const id = await primeiroAchado();
      if (id === null) {
        return;
      }

      const r = await call(
        'POST',
        `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id)}/reversal`,
        owner,
      );

      expect(r.statusCode).toBe(422);
      expect(r.json().blockers).toContain('achado_nao_aceito_pelo_contador');
    });

    /**
     * O caminho inteiro dos três atos: o sistema examina, o contador aceita, e
     * só então o estorno é aplicado — com a norma citada no resultado, que é o
     * que o escritório leva ao cliente.
     */
    it('achado aceito pelo contador pode ser estornado, e o estorno cita a norma', async () => {
      await conferirCriterios();
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);

      const id = await primeiroAchado();
      expect(id).not.toBeNull();

      const revisao = await call(
        'POST',
        `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id!)}/review`,
        owner,
        { status: 'accepted' },
      );
      expect(revisao.statusCode).toBe(200);

      const estorno = await call(
        'POST',
        `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id!)}/reversal`,
        owner,
      );
      const corpo = estorno.json();

      expect(estorno.statusCode).toBe(201);
      expect(corpo.credit_reversed_cents).toBeGreaterThan(0);
      expect(corpo.net_effect_cents).toBe(corpo.credit_reversed_cents);
      expect(String(corpo.citation).length).toBeGreaterThan(0);

      // O requisito humano está no schema: quem aplicou fica gravado.
      const { rows } = await pool.query<{ applied_by: string; net_effect_cents: string }>(
        `select applied_by::text, net_effect_cents::text
           from audit_reversals where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.applied_by).toBe(owner);
    });

    /** Aplicar duas vezes dobraria o efeito na apuração. */
    it('o mesmo achado não é estornado duas vezes', async () => {
      await conferirCriterios();
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);

      const id = await primeiroAchado();
      expect(id).not.toBeNull();
      await call('POST', `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id!)}/review`, owner, {
        status: 'accepted',
      });
      await call('POST', `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id!)}/reversal`, owner);

      const segundo = await call(
        'POST',
        `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id!)}/reversal`,
        owner,
      );

      expect(segundo.statusCode).toBe(422);
      expect(segundo.json().blockers).toContain('estorno_ja_aplicado');
    });

    it('recusar com justificativa é aceito e a justificativa fica gravada', async () => {
      await conferirCriterios();
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);

      const id = await primeiroAchado();
      expect(id).not.toBeNull();

      const r = await call(
        'POST',
        `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(id!)}/review`,
        owner,
        { status: 'rejected', note: 'Chave conferida no portal; o XML local está truncado.' },
      );

      expect(r.statusCode).toBe(200);

      const { rows } = await pool.query<{ review_note: string; status: string }>(
        `select review_note, status from audit_findings
          where tenant_id = $1::uuid and cnpj = $2::char(14) and finding_id = $3`,
        [tenantId, cnpj, id],
      );
      expect(rows[0]!.status).toBe('rejected');
      expect(rows[0]!.review_note).toContain('portal');
    });

    it('estorno de achado inexistente não vaza a existência de outro escritório', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/audit/findings/nao-existe/reversal`, owner);

      expect(r.statusCode).toBe(422);
    });
  });
});
