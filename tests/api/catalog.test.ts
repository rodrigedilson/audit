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

describe.skipIf(!DATABASE_URL)('API — catálogo e saúde do cadastro', () => {
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
    method: 'GET' | 'PUT',
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

  const classificar = (itemId: string, body: Record<string, unknown>, userId = owner) =>
    call('PUT', `/v1/clients/${cnpj}/items/${itemId}/classification`, userId, body);

  const classificacaoValida = {
    effective_from: '2027-01',
    ncm: '73181500',
    cfop_default: '5102',
    cst_icms: '00',
    cst_pis_cofins: '01',
    cst_ibs_cbs: '000',
    cclasstrib: '000001',
    justification: 'Conferido com a nota do fornecedor',
  };

  /** Carrega um punhado de códigos oficiais, para as checagens saírem do "não verificado". */
  const carregarTabelas = async (): Promise<void> => {
    await pool.query(
      `insert into fiscal_codes (kind, code) values
         ('ncm','73181500'),('ncm','84713012'),
         ('cfop','5102'),('cst_icms','00'),('cst_pis_cofins','01'),
         ('cst_ibs_cbs','000'),('cst_ibs_cbs','200')
       on conflict do nothing`,
    );
    await pool.query(
      `insert into cclasstrib_cst (cclasstrib, cst_ibs_cbs) values
         ('000001','000'),('200001','200')
       on conflict do nothing`,
    );
    await pool.query(
      `insert into ncm_flags (ncm, monophasic, tax_substitution) values
         ('84713012', true, false)
       on conflict do nothing`,
    );
  };

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
    tenantId = await createTenant(pool, 'Escritório do Catálogo');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj);
    await carregarTabelas();
  });

  describe('classificação de item', () => {
    it('classifica e devolve saúde ok com event_seq e hash', async () => {
      const r = await classificar('SKU-1', classificacaoValida);

      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ action: 'item.classified', health: 'ok' });
      expect(r.json().issues).toEqual([]);
      expect(r.json().projection_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    /** Reclassificar é ato que o contador pode precisar justificar depois. */
    it('a segunda vez emite item.reclassified, não item.classified', async () => {
      await classificar('SKU-1', classificacaoValida);

      const r = await classificar('SKU-1', { ...classificacaoValida, effective_from: '2027-02' });

      expect(r.json().action).toBe('item.reclassified');
    });

    it('preserva a classificação anterior em vez de sobrescrever', async () => {
      await classificar('SKU-1', classificacaoValida);
      await classificar('SKU-1', {
        ...classificacaoValida,
        effective_from: '2027-06',
        cst_ibs_cbs: '200',
        cclasstrib: '200001',
      });

      const { rows } = await pool.query<{ effective_from: string; cclasstrib: string }>(
        `select effective_from, cclasstrib from item_classifications
          where tenant_id = $1::uuid and cnpj = $2 and item_id = 'SKU-1'
          order by effective_from`,
        [tenantId, cnpj],
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]!.cclasstrib.trim()).toBe('000001');
      expect(rows[1]!.cclasstrib.trim()).toBe('200001');
    });

    it('devolve as marcações do NCM quando conhecidas', async () => {
      const r = await classificar('SKU-MONO', { ...classificacaoValida, ncm: '84713012' });

      expect(r.json().ncm_flags).toEqual({ monophasic: true, taxSubstitution: false });
    });

    /**
     * Inconsistência de mérito não bloqueia o registro: o contador pode precisar
     * classificar exatamente como está no documento do fornecedor, e a
     * inconsistência é o que o produto tem de mostrar. Bloquear faria o
     * escritório resolver isso fora do sistema, sem trilha.
     */
    it('registra classificação incompatível, marcando como error', async () => {
      const r = await classificar('SKU-RUIM', {
        ...classificacaoValida,
        cst_ibs_cbs: '200',
        cclasstrib: '000001',
      });

      expect(r.statusCode).toBe(200);
      expect(r.json().health).toBe('error');
      const issue = r.json().issues.find((i: { reason: string }) => i.reason === 'code_incompatible');
      expect(issue.severity).toBe('critical');
      expect(issue.suggestedFix).toBeTruthy();
    });

    it('acusa NCM inexistente na tabela oficial', async () => {
      const r = await classificar('SKU-NCM', { ...classificacaoValida, ncm: '99999999' });

      expect(r.json().health).toBe('error');
      expect(r.json().issues.some((i: { reason: string }) => i.reason === 'unknown_code')).toBe(true);
    });

    it('avisa item sem classificação de IBS/CBS', async () => {
      const { cst_ibs_cbs: _a, cclasstrib: _b, ...legado } = classificacaoValida;

      const r = await classificar('SKU-LEGADO', legado);

      expect(r.json().health).toBe('warning');
      expect(
        r.json().issues.some(
          (i: { reason: string }) => i.reason === 'missing_reform_classification',
        ),
      ).toBe(true);
    });

    /**
     * INV-001 aplicado ao catálogo: a classificação vigente é a de maior
     * `effective_from` até o período, então classificar com vigência dentro de
     * uma competência confirmada mudaria retroativamente aquela apuração.
     */
    it('recusa vigência que cai em competência já confirmada', async () => {
      await pool.query(
        `insert into periods (tenant_id, cnpj, period, state, projection_hash, confirmed_at)
         values ($1::uuid, $2::char(14), '2027-01', 'confirmed', 'hash-da-epoca', now())`,
        [tenantId, cnpj],
      );
      // A projeção do CNPJ é derivada do log, então o período precisa vir de lá.
      await call('GET', `/v1/clients/${cnpj}/events`, owner);
      const orquestrado = await pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'period.opened',
                             '2027-01', $3::text, '2027-01'::char(7), now(), '0.5.0',
                             '{"period":"2027-01"}'::jsonb)`,
        [tenantId, cnpj, owner],
      );
      expect(orquestrado.rows).toHaveLength(1);
      await pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'assessment.projected',
                             '2027-01', $3::text, '2027-01'::char(7), now(), '0.5.0', '{}'::jsonb)`,
        [tenantId, cnpj, owner],
      );
      await pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'assessment.compared',
                             '2027-01', $3::text, '2027-01'::char(7), now(), '0.5.0', '{}'::jsonb)`,
        [tenantId, cnpj, owner],
      );
      await pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'assessment.confirmed',
                             '2027-01', $3::text, '2027-01'::char(7), now(), '0.5.0',
                             '{"period":"2027-01","projection_hash":"h"}'::jsonb)`,
        [tenantId, cnpj, owner],
      );

      const r = await classificar('SKU-RETRO', { ...classificacaoValida, effective_from: '2027-01' });

      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ rejected: true, layer: 6 });
      expect(r.json().message).toMatch(/confirmada/);
      expect(r.json().message).toMatch(/retifica/);
    });

    it('aceita vigência posterior à competência confirmada', async () => {
      await pool.query(
        `select append_event($1::uuid, $2::char(14), gen_random_uuid(), 'period.opened',
                             '2027-01', $3::text, '2027-01'::char(7), now(), '0.5.0',
                             '{"period":"2027-01"}'::jsonb)`,
        [tenantId, cnpj, owner],
      );

      const r = await classificar('SKU-FUTURO', {
        ...classificacaoValida,
        effective_from: '2027-02',
      });

      expect(r.statusCode).toBe(200);
    });

    it('recusa competência de vigência malformada', async () => {
      expect((await classificar('SKU-1', { ...classificacaoValida, effective_from: '2027/01' })).statusCode).toBe(400);
    });

    it('viewer não classifica', async () => {
      expect((await classificar('SKU-1', classificacaoValida, viewer)).statusCode).toBe(403);
    });

    it('a classificação vira evento no log', async () => {
      await classificar('SKU-1', classificacaoValida);

      const eventos = (
        await call('GET', `/v1/clients/${cnpj}/events?action=item.classified`, owner)
      ).json();

      expect(eventos).toHaveLength(1);
      expect(eventos[0].payload).toMatchObject({ item_id: 'SKU-1', health: 'ok' });
    });
  });

  describe('listagem de itens', () => {
    beforeEach(async () => {
      await classificar('SKU-OK', classificacaoValida);
      await classificar('SKU-ERRO', {
        ...classificacaoValida,
        cst_ibs_cbs: '200',
        cclasstrib: '000001',
      });
      const { cst_ibs_cbs: _a, cclasstrib: _b, ...legado } = classificacaoValida;
      await classificar('SKU-AVISO', legado);
    });

    it('lista os itens com saúde e motivos', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/items`, owner)).json();

      expect(body.total).toBe(3);
      const erro = body.items.find((i: { item_id: string }) => i.item_id === 'SKU-ERRO');
      expect(erro.health).toBe('error');
      expect(erro.health_reasons.length).toBeGreaterThan(0);
    });

    /** É a ordem em que o escritório deve atacar a fila. */
    it('ordena pior saúde primeiro', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/items`, owner)).json();

      expect(body.items[0].health).toBe('error');
    });

    it('filtra por saúde', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/items?health=error`, owner)).json();

      expect(body.items).toHaveLength(1);
      expect(body.items[0].item_id).toBe('SKU-ERRO');
    });
  });

  describe('saúde do cadastro', () => {
    it('resume os itens por saúde', async () => {
      await classificar('SKU-OK', classificacaoValida);
      await classificar('SKU-ERRO', {
        ...classificacaoValida,
        cst_ibs_cbs: '200',
        cclasstrib: '000001',
      });

      const body = (await call('GET', `/v1/clients/${cnpj}/items/health`, owner)).json();

      expect(body).toMatchObject({ items_total: 2, ok: 1, error: 1 });
      expect(body.reference_tables_loaded).toBe(true);
      expect(body.top_reasons.length).toBeGreaterThan(0);
    });

    /**
     * O defeito que o dado real expos. `item_propagation()` partia de
     * `item_classifications`, entao item NUNCA classificado nao aparecia na
     * propagacao — e a resposta dizia "474 itens com aviso" ao lado de
     * "0 notas afetadas, R$ 0,00 em jogo".
     *
     * O numero que sustenta o diferencial #1 lia zero exatamente no estado em
     * que mais importa: o do escritorio que acabou de ingerir e ainda nao
     * classificou nada. Medido em producao: 474 itens em 578 linhas de
     * documento, R$ 1.420.745,30, propagacao zero.
     */
    it('item nunca classificado propaga para as notas que o usam', async () => {
      const chave = '35270999888777000166550010000000019876543210';

      await pool.query(
        `insert into items (tenant_id, cnpj, item_id, description)
         values ($1::uuid, $2::char(14), 'SKU-SEM-CLASSIFICACAO', 'Produto ainda nao classificado')`,
        [tenantId, cnpj],
      );

      await pool.query(
        `insert into documents (
           tenant_id, cnpj, access_key, model, direction, issued_at, period,
           issuer_cnpj, total_cents, event_seq
         ) values ($1::uuid, $2::char(14), $3::char(44), 'nfe', 'outbound',
                   '2027-09-15T10:00:00Z', '2027-09', $2::char(14), 250000, 0)`,
        [tenantId, cnpj, chave],
      );

      await pool.query(
        `insert into document_items (
           tenant_id, cnpj, access_key, line, code, total_cents
         ) values ($1::uuid, $2::char(14), $3::char(44), 1, 'SKU-SEM-CLASSIFICACAO', 250000)`,
        [tenantId, cnpj, chave],
      );

      const body = (await call('GET', `/v1/clients/${cnpj}/items/health`, owner)).json();

      // Nunca classificado e um estado proprio: nao e "ok", e nao e "aviso".
      // Aviso e trabalho feito com pendencia; nunca classificado e trabalho que
      // nao comecou, e o escritorio faz coisas diferentes com cada um.
      expect(body.items_total).toBe(1);
      expect(body.never_classified).toBe(1);
      expect(body.warning).toBe(0);

      // A soma fecha: nenhum item cai em duas contagens nem em nenhuma.
      expect(body.ok + body.warning + body.error + body.never_classified).toBe(
        body.items_total,
      );

      // E o que o defeito escondia: a nota emitida que carrega esse item.
      expect(body.outbound_documents_affected).toBe(1);
      expect(body.amount_at_stake_cents).toBe(250_000);
    });

    /**
     * O filtro tem de casar com o que a lista mostra.
     *
     * `health=warning` nao devolvia o item nunca classificado, embora a lista o
     * exibisse com badge de aviso: filtrar pelo valor do proprio badge fazia a
     * linha sumir, e o contador concluia que tinha resolvido o item.
     */
    it('o filtro never isola o item nunca classificado', async () => {
      await pool.query(
        `insert into items (tenant_id, cnpj, item_id, description)
         values ($1::uuid, $2::char(14), 'SKU-NUNCA', 'Item sem classificacao')`,
        [tenantId, cnpj],
      );
      await call('PUT', `/v1/clients/${cnpj}/items/SKU-CLASSIFICADO/classification`, owner, {
        effective_from: '2027-09',
        ncm: '12345678',
      });

      const nunca = (await call('GET', `/v1/clients/${cnpj}/items?health=never`, owner)).json();
      expect(nunca.items.map((i: { item_id: string }) => i.item_id)).toEqual(['SKU-NUNCA']);
      expect(nunca.items[0].never_classified).toBe(true);

      // Filtrar pelo badge que a lista mostra tem de devolver a linha. Descobre
      // o badge do item classificado e filtra por ele.
      const todos = (await call('GET', `/v1/clients/${cnpj}/items`, owner)).json()
        .items as { item_id: string; health: string; never_classified: boolean }[];
      const classificado = todos.find((i) => i.item_id === 'SKU-CLASSIFICADO')!;
      expect(classificado.never_classified).toBe(false);

      const porBadge = (
        await call('GET', `/v1/clients/${cnpj}/items?health=${classificado.health}`, owner)
      ).json();
      const ids = porBadge.items.map((i: { item_id: string }) => i.item_id);
      expect(ids).toContain('SKU-CLASSIFICADO');
      expect(ids).not.toContain('SKU-NUNCA');
    });

    it('carteira sem item classificado devolve zeros sem erro', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/items/health`, owner)).json();

      expect(body).toMatchObject({ items_total: 0, ok: 0, warning: 0, error: 0 });
    });

    /**
     * A decisão que mantém o resultado honesto: sem as tabelas oficiais, a
     * resposta diz que a ausência de erro não significa correção.
     */
    it('avisa quando as tabelas oficiais não estão carregadas', async () => {
      await pool.query('delete from cclasstrib_cst');
      await pool.query('delete from fiscal_codes');

      try {
        await classificar('SKU-X', classificacaoValida);
        const body = (await call('GET', `/v1/clients/${cnpj}/items/health`, owner)).json();

        expect(body.reference_tables_loaded).toBe(false);
        expect(body.notice).toMatch(/não significa que a classificação está correta/);
        expect(body.not_verified).toBeGreaterThan(0);
      } finally {
        await carregarTabelas();
      }
    });

    it('a resposta não traz notice quando as tabelas estão carregadas', async () => {
      const body = (await call('GET', `/v1/clients/${cnpj}/items/health`, owner)).json();

      expect(body.notice).toBeUndefined();
    });
  });
});
