import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { accessKey } from '../helpers/nfe-xml.js';
import { AuditService } from '../../src/fiscal/audit/audit.service.js';
import { TRILHAS_INICIAIS } from '../../src/fiscal/audit/trilhas-iniciais.js';
import { emptyCodeTables } from '../../src/fiscal/catalog/code-validation.js';
import { EventScope } from '../../src/esaa/core/event-store/value-objects/event-scope.vo.js';

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

  /**
   * A população vista com o dado que o banco tem. Antes o motor recebia tabelas
   * vazias, nenhuma classificação, e a competência de apropriação copiada da
   * de emissão — e a verificação 2 passava sempre.
   */
  describe('população com dado real', () => {
    const EMITENTE = '11222333000181';
    const trilha = (id: string) => TRILHAS_INICIAIS.find((t) => t.procedureId === id)!;
    const escopo = (): EventScope => EventScope.create(tenantId, cnpj);

    const conferirCriterios = async (): Promise<void> => {
      await pool.query(
        `update evaluation_criteria
            set verified = true, source_ref = 'conferido no teste', verified_at = now()`,
      );
    };

    const documentoDeEntrada = async (period: string, numero: string): Promise<string> => {
      const chave = accessKey(EMITENTE, numero);
      await pool.query(
        `insert into documents
           (tenant_id, cnpj, access_key, model, direction, issued_at, period,
            issuer_cnpj, counterparty_cnpj, total_cents, event_seq)
         values ($1::uuid, $2::char(14), $3::char(44), 'nfe', 'inbound',
                 $4::timestamptz, $5::char(7), $6::char(14), $2::char(14), 180000, 0)`,
        [tenantId, cnpj, chave, `${period}-10T12:00:00Z`, period, EMITENTE],
      );
      return chave;
    };

    /** A EFD-Contribuições da competência, declarando a nota como entrada. */
    const escriturar = async (period: string, chave: string): Promise<void> => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into sped_files
           (tenant_id, cnpj, period, kind, layout_version, reference, event_seq)
         values ($1::uuid, $2::char(14), $3::char(7), 'original', '006', 'teste', 0)
         returning id`,
        [tenantId, cnpj, period],
      );
      await pool.query(
        `insert into sped_documents (tenant_id, cnpj, sped_file_id, operation, model, access_key)
         values ($1::uuid, $2::char(14), $3::uuid, 'inbound', '55', $4::char(44))`,
        [tenantId, cnpj, rows[0]!.id, chave],
      );
    };

    it('sem EFD, a apropriação é desconhecida e o crédito extemporâneo não conclui', async () => {
      await conferirCriterios();
      await documentoDeEntrada(PERIODO, '000000101');
      const audit = new AuditService(pool);

      const populacao = await audit.population(escopo(), PERIODO);
      const saida = await audit.run(escopo(), trilha('credito-extemporaneo'), PERIODO, '2027-04-01');

      expect(populacao).toHaveLength(1);
      expect(populacao[0]!.appropriatedPeriod).toBeNull();
      // Regressão: antes saía `completed`, sem achado — "limpo" onde nada foi comparado.
      expect(saida.status).toBe('inconclusive');
      expect(saida.findings).toHaveLength(0);
    });

    it('com EFD, a nota emitida antes e escriturada na competência é crédito extemporâneo', async () => {
      await conferirCriterios();
      const chave = await documentoDeEntrada('2027-02', '000000102');
      await escriturar(PERIODO, chave);
      const audit = new AuditService(pool);

      const populacao = await audit.population(escopo(), PERIODO);
      const saida = await audit.run(escopo(), trilha('credito-extemporaneo'), PERIODO, '2027-04-01');

      expect(populacao.map((s) => s.subject)).toEqual([chave]);
      expect(populacao[0]!.documentPeriod).toBe('2027-02');
      expect(populacao[0]!.appropriatedPeriod).toBe(PERIODO);
      expect(saida.status).toBe('completed');
      expect(saida.findings).toHaveLength(1);
      expect(saida.findings[0]!.failed).toContain('v2_data_documento_x_lancamento');
    });

    it('com EFD, nota emitida na competência e não escriturada não é crédito dela', async () => {
      const escriturada = await documentoDeEntrada(PERIODO, '000000103');
      await documentoDeEntrada(PERIODO, '000000104');
      await escriturar(PERIODO, escriturada);

      const populacao = await new AuditService(pool).population(escopo(), PERIODO);

      expect(populacao.map((s) => s.subject)).toEqual([escriturada]);
    });

    it('a trilha de classificação examina itens, com a classificação vigente na competência', async () => {
      await conferirCriterios();
      const chave = await documentoDeEntrada(PERIODO, '000000105');
      await pool.query(
        `insert into document_items (tenant_id, cnpj, access_key, line, code, ncm, total_cents)
         values ($1::uuid, $2::char(14), $3::char(44), 1, 'SKU-AUD', '99999999', 40000)`,
        [tenantId, cnpj, chave],
      );
      await pool.query(
        `insert into items (tenant_id, cnpj, item_id) values ($1::uuid, $2::char(14), 'SKU-AUD')`,
        [tenantId, cnpj],
      );
      await pool.query(
        `insert into item_classifications (tenant_id, cnpj, item_id, effective_from, ncm, event_seq)
         values ($1::uuid, $2::char(14), 'SKU-AUD', '2027-01', '99999999', 0)`,
        [tenantId, cnpj],
      );
      const tabelas = { ...emptyCodeTables(), ncm: new Set(['30049099']) };
      const audit = new AuditService(pool);
      const procedimento = trilha('classificacao-incompativel');

      const saida = await audit.run(escopo(), procedimento, PERIODO, '2027-04-01', tabelas);

      expect(saida.populationSize).toBe(1);
      expect(saida.findings).toHaveLength(1);
      expect(saida.findings[0]!.subject).toBe('SKU-AUD');
      expect(saida.findings[0]!.failed).toContain('v3_lancamento_correto');
      // Somente achado: item não é crédito, nada sai do saldo.
      expect(saida.findings[0]!.impactSide).toBe('sem_efeito_no_saldo');

      await audit.persist(escopo(), saida, procedimento, 0, owner);
      const { rows } = await pool.query<{ subject_kind: string }>(
        `select subject_kind from audit_findings where tenant_id = $1::uuid and cnpj = $2::char(14)`,
        [tenantId, cnpj],
      );
      expect(rows.map((r) => r.subject_kind)).toEqual(['itens_do_catalogo']);
    });
  });

  /** O que a tela lê: critério antes de rodar, execução por trilha, impedimentos. */
  describe('leitura para a tela', () => {
    const conferirCriterios = async (): Promise<void> => {
      await pool.query(
        `update evaluation_criteria
            set verified = true, source_ref = 'conferido no teste', verified_at = now()`,
      );
    };

    const executar = () => call('POST', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, owner);
    const achados = async () =>
      (await call('GET', `/v1/clients/${cnpj}/audit/${PERIODO}/findings`, owner)).json().findings;

    it('o catálogo traz o critério de cada trilha, com o estado da conferência', async () => {
      const corpo = (await call('GET', '/v1/audit-procedures', viewer)).json();

      for (const p of corpo.procedures) {
        expect(p.criterion).not.toBeNull();
        expect(p.criterion.criterion_id).toBe(p.criterion_id);
        expect(p.criterion.verified).toBe(false);
        expect(String(p.criterion.citation).length).toBeGreaterThan(0);
      }
    });

    it('antes de executar, a lista de execuções é vazia — nunca executada', async () => {
      const r = await call('GET', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, viewer);

      expect(r.statusCode).toBe(200);
      expect(r.json().executions).toEqual([]);
    });

    it('depois de executar duas vezes, lista só a última de cada trilha', async () => {
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      const primeira = (await executar()).json();
      await executar();

      const corpo = (await call('GET', `/v1/clients/${cnpj}/audit/${PERIODO}/executions`, viewer)).json();

      expect(corpo.executions).toHaveLength(primeira.executions.length);
      for (const e of corpo.executions) {
        expect(e.status).toBe('inconclusive');
        expect(e.event_seq).toBeGreaterThan(0);
        expect(e.executed_by).toBe(owner);
        expect(typeof e.total_impact_cents).toBe('number');
      }
    });

    it('o achado vem com impacto numérico e os impedimentos do estorno', async () => {
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await executar();

      const [achado] = await achados();

      expect(typeof achado.impact_cents).toBe('number');
      expect(achado.reversed).toBe(false);
      expect(achado.reversal_blockers).toEqual(
        expect.arrayContaining(['criterio_nao_conferido', 'achado_nao_aceito_pelo_contador']),
      );
    });

    /** A tela e o portão dão a mesma resposta: impedimento vazio é estorno aceito. */
    it('critério conferido e achado aceito zeram os impedimentos; o estorno aplicado volta como impedimento', async () => {
      await conferirCriterios();
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await executar();
      const alvo = (await achados()).find(
        (a: { impact_side: string }) => a.impact_side === 'credito_a_estornar',
      );
      const url = `/v1/clients/${cnpj}/audit/findings/${encodeURIComponent(alvo.finding_id)}`;
      await call('POST', `${url}/review`, owner, { status: 'accepted' });

      const aceito = (await achados()).find(
        (a: { finding_id: string }) => a.finding_id === alvo.finding_id,
      );
      expect(aceito.reversal_blockers).toEqual([]);

      expect((await call('POST', `${url}/reversal`, owner)).statusCode).toBe(201);
      const estornado = (await achados()).find(
        (a: { finding_id: string }) => a.finding_id === alvo.finding_id,
      );
      expect(estornado.reversed).toBe(true);
      expect(estornado.reversal_blockers).toContain('estorno_ja_aplicado');
    });

    it('o painel do escritório conta os achados abertos e aponta o CNPJ', async () => {
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await executar();
      const abertos = (await achados()).length;

      const corpo = (await call('GET', '/v1/audit/overview', viewer)).json();

      expect(corpo.open_findings.total).toBe(abertos);
      expect(corpo.open_assertable).toBe(0);
      expect(corpo.clients_total).toBe(1);
      expect(corpo.clients_never_audited).toBe(0);
      expect(corpo.top_clients[0].cnpj).toBe(cnpj);
      expect(corpo.last_execution_at).not.toBeNull();
    });

    it('o painel não mostra a carteira de outro escritório', async () => {
      await abrirCompetencia();
      await documentoComChaveQuebrada();
      await executar();
      const outro = await createTenant(pool, 'Outro escritório');
      const estranho = await createMembership(pool, outro, 'owner');

      const corpo = (await call('GET', '/v1/audit/overview', estranho)).json();

      expect(corpo.open_findings.total).toBe(0);
      expect(corpo.top_clients).toEqual([]);
      expect(corpo.clients_total).toBe(0);
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
