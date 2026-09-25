import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createMembership, createTenant } from '../helpers/db.js';
import {
  carregarIndices,
  indicesDesatualizados,
  startIndicesScheduler,
  type FetchJson,
} from '../../src/fiscal/rules/index-loader.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

describe.skipIf(!DATABASE_URL)('API — séries de índice e correção monetária', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let owner: string;

  const call = async (url: string, userId?: string) => {
    const headers: Record<string, string> = {};
    if (userId !== undefined) {
      headers['authorization'] = `Bearer ${await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode(JWT_SECRET))}`;
    }
    return app.inject({ method: 'GET', url, headers });
  };

  /** Carrega 1% ao mês, para a conta fechar à mão. */
  const carregarPontos = async (periods: readonly string[]): Promise<void> => {
    for (const period of periods) {
      await pool.query(
        `insert into financial_index_points (index_id, period, variation, source_ref)
         values ('ipca', $1::char(7), 0.01, 'conferido no teste')
         on conflict (index_id, period) do update set variation = excluded.variation`,
        [period],
      );
    }
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
    const tenantId = await createTenant(pool, 'Escritório dos Índices');
    owner = await createMembership(pool, tenantId, 'owner');

    /**
     * As séries são GLOBAIS — não têm `tenant_id`, porque um índice não
     * pertence a um escritório. O isolamento por tenant que o resto da suíte usa
     * não vale aqui, então cada teste devolve a tabela ao estado de nascimento.
     */
    await pool.query('delete from financial_index_points');
    await pool.query(
      `update financial_indices set verified = false, source_ref = null, verified_at = null`,
    );
  });

  describe('catálogo', () => {
    it('lista as séries e diz quantas têm dado carregado', async () => {
      const r = await call('/v1/financial-indices', owner);
      const corpo = r.json();

      expect(r.statusCode).toBe(200);
      expect(corpo.indices.map((i: { index_id: string }) => i.index_id)).toContain('ipca');
      // Nascem vazias: catálogo sem ponto não corrige nada.
      expect(corpo.loaded_count).toBe(0);
      expect(corpo.verified_count).toBe(0);
    });

    it('a cobertura aparece depois de carregar pontos', async () => {
      await carregarPontos(['2027-02', '2027-03']);

      const corpo = (await call('/v1/financial-indices', owner)).json();
      const ipca = corpo.indices.find((i: { index_id: string }) => i.index_id === 'ipca');

      expect(ipca.point_count).toBe(2);
      expect(ipca.first_period).toBe('2027-02');
      expect(ipca.last_period).toBe('2027-03');
      expect(corpo.loaded_count).toBe(1);
    });

    it('não responde sem token — a série é do módulo de perícia, não do público', async () => {
      expect((await call('/v1/financial-indices')).statusCode).toBe(401);
    });
  });

  describe('fator acumulado', () => {
    it('acumula de from exclusivo até to inclusivo', async () => {
      await carregarPontos(['2027-02', '2027-03']);

      const corpo = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-03', owner)
      ).json();

      expect(corpo.months).toBe(2);
      expect(corpo.factor).toBeCloseTo(1.0201, 8);
      expect(corpo.source).toBe('IBGE');
    });

    /**
     * Série sem cobertura não é erro do chamador: é dado que falta carregar.
     * Devolver 4xx faria a tela tratar como falha o que é estado normal.
     */
    it('intervalo descoberto devolve 200 com o motivo, e fator nulo', async () => {
      await carregarPontos(['2027-02']);

      const r = await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-04', owner);

      expect(r.statusCode).toBe(200);
      expect(r.json().factor).toBeNull();
      expect(r.json().unavailable_reason).toContain('2027-03');
    });

    it('série vazia também devolve 200 com o motivo', async () => {
      const r = await call('/v1/financial-indices/igpm/factor?from=2027-01&to=2027-03', owner);

      expect(r.statusCode).toBe(200);
      expect(r.json().factor).toBeNull();
    });

    /** Índice fora do catálogo é erro de quem chamou, e aí sim é 4xx. */
    it('índice inexistente é rejeitado', async () => {
      const r = await call('/v1/financial-indices/nao-existe/factor?from=2027-01&to=2027-03', owner);

      expect(r.statusCode).toBe(422);
    });

    it('competência malformada é barrada pelo schema', async () => {
      const r = await call('/v1/financial-indices/ipca/factor?from=2027-13&to=2027-03', owner);

      expect(r.statusCode).toBe(400);
    });

    it('a série declara se foi conferida, para o laudo poder ressalvar', async () => {
      await carregarPontos(['2027-02']);
      const antes = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-02', owner)
      ).json();
      expect(antes.verified).toBe(false);

      await pool.query(
        `update financial_indices set verified = true, source_ref = 'https://ibge…',
                verified_at = now() where index_id = 'ipca'`,
      );
      const depois = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-02', owner)
      ).json();

      expect(depois.verified).toBe(true);
    });
  });

  describe('correção de um principal', () => {
    it('corrige e devolve a memória de cálculo junto', async () => {
      await carregarPontos(['2027-02', '2027-03']);

      const corpo = (
        await call(
          '/v1/financial-indices/ipca/factor?from=2027-01&to=2027-03&principal_cents=100000',
          owner,
        )
      ).json();

      // 100.000 × 1,0201 = 102.010
      expect(corpo.restated_cents).toBe(102_010);
      expect(corpo.correction_cents).toBe(2_010);
      expect(corpo.steps.length).toBeGreaterThan(0);
    });

    it('sem principal informado devolve só o fator, sem memória', async () => {
      await carregarPontos(['2027-02']);

      const corpo = (
        await call('/v1/financial-indices/ipca/factor?from=2027-01&to=2027-02', owner)
      ).json();

      expect(corpo.restated_cents).toBeUndefined();
      expect(corpo.steps).toBeUndefined();
    });

    it('intervalo descoberto não corrige, e diz por quê', async () => {
      const corpo = (
        await call(
          '/v1/financial-indices/ipca/factor?from=2027-01&to=2027-06&principal_cents=100000',
          owner,
        )
      ).json();

      expect(corpo.restated_cents).toBeNull();
      expect(String(corpo.unavailable_reason).length).toBeGreaterThan(0);
    });
  });

  /**
   * Carga das fontes oficiais, com o IBGE e o BCB dublados. A API dublada
   * responde por janela, como as de verdade: o carregador pede em trechos de
   * cinco anos, e o SGS responde 404 quando a janela não tem dado.
   */
  describe('carga das fontes oficiais', () => {
    /** 25/09/2026 em Brasília: a última competência fechada é 2026-08. */
    const AGORA = new Date('2026-09-25T15:00:00Z');

    /** 0,50% ao mês em toda série, salvo o que o teste mudar. */
    const fonte = (mudar: Record<string, Record<string, string>> = {}, semDado: string[] = []): { fetchJson: FetchJson; urls: string[] } => {
      const urls: string[] = [];
      const fetchJson: FetchJson = async (url) => {
        urls.push(url);
        const sidra = /values\/t\/(\d+)\/n1\/all\/v\/(\d+)\/p\/(\d{6})-(\d{6})/.exec(url);
        const sgs = /bcdata\.sgs\.(\d+)\/dados\?formato=json&dataInicial=\d{2}\/(\d{2})\/(\d{4})&dataFinal=\d{2}\/(\d{2})\/(\d{4})/.exec(url);
        const meses = (de: string, ate: string): string[] => {
          const r: string[] = [];
          for (let [a, m] = [Number(de.slice(0, 4)), Number(de.slice(5))]; `${a}-${String(m).padStart(2, '0')}` <= ate; m === 12 ? ((a += 1), (m = 1)) : (m += 1)) {
            r.push(`${a}-${String(m).padStart(2, '0')}`);
          }
          return r;
        };
        if (sidra !== null) {
          const chave = `t${sidra[1]}/v${sidra[2]}`;
          const lista = meses(`${sidra[3]!.slice(0, 4)}-${sidra[3]!.slice(4)}`, `${sidra[4]!.slice(0, 4)}-${sidra[4]!.slice(4)}`)
            .filter((p) => !semDado.includes(`${chave}:${p}`));
          return {
            status: 200,
            json: [{ D3C: 'Mês (Código)', V: 'Valor' }, ...lista.map((p) => ({ D3C: p.replace('-', ''), V: mudar[chave]?.[p] ?? '0.50' }))],
          };
        }
        if (sgs !== null) {
          const lista = meses(`${sgs[3]}-${sgs[2]}`, `${sgs[5]}-${sgs[4]}`).filter((p) => !semDado.includes(`${sgs[1]}:${p}`));
          if (lista.length === 0) return { status: 404, json: null };
          return {
            status: 200,
            json: lista.map((p) => ({ data: `01/${p.slice(5)}/${p.slice(0, 4)}`, valor: mudar[sgs[1]!]?.[p] ?? '0.50' })).reverse(),
          };
        }
        throw new Error(`URL inesperada: ${url}`);
      };
      return { fetchJson, urls };
    };

    const pontos = async (indexId: string) =>
      Number((await pool.query('select count(*) n from financial_index_points where index_id = $1', [indexId])).rows[0].n);

    it('sem executar, relata e não grava nada', async () => {
      const { fetchJson } = fonte();
      const relatorios = await carregarIndices({ pool, fetchJson, now: AGORA, desde: '2025-01', executar: false });

      expect(relatorios.map((r) => [r.indexId, r.points, r.lastPeriod])).toEqual([
        ['ipca', 20, '2026-08'],
        ['inpc', 20, '2026-08'],
        ['igpm', 20, '2026-08'],
        ['tr', 20, '2026-08'],
        ['selic', 20, '2026-08'],
      ]);
      expect(await pontos('ipca')).toBe(0);
    });

    it('grava as cinco séries, conferidas, e a correção passa a sair', async () => {
      const { fetchJson } = fonte();
      await carregarIndices({ pool, fetchJson, now: AGORA, desde: '2025-01', executar: true });

      const catalogo = (await call('/v1/financial-indices', owner)).json();
      expect(catalogo.loaded_count).toBe(5);
      expect(catalogo.verified_count).toBe(5);
      const { rows } = await pool.query("select source_ref from financial_indices where index_id = 'ipca'");
      expect(rows[0].source_ref).toMatch(/IBGE SIDRA t1737\/v63, conferido contra BCB SGS 433; coleta em 2026-09-25/);

      const fator = (await call('/v1/financial-indices/ipca/factor?from=2025-01&to=2025-03', owner)).json();
      // Dois meses a 0,50%: 1,005² = 1,010025.
      expect(fator.factor).toBeCloseTo(1.010025, 10);
    });

    it('IBGE e BCB divergindo: grava, e a série fica não conferida com o mês', async () => {
      const { fetchJson } = fonte({ '433': { '2026-03': '0.51' } });
      const [ipca] = await carregarIndices({ pool, fetchJson, now: AGORA, desde: '2025-01', indices: ['ipca'], executar: true });

      expect(ipca!.verified).toBe(false);
      expect(ipca!.notVerifiedReason).toMatch(/2026-03 \(0\.50% × 0\.51%\)/);
      expect(await pontos('ipca')).toBe(20);
      const { rows } = await pool.query("select verified, verified_at from financial_indices where index_id = 'ipca'");
      expect(rows[0]).toEqual({ verified: false, verified_at: null });
    });

    it('revisão da fonte é atualizada e relatada', async () => {
      await carregarIndices({ pool, fetchJson: fonte().fetchJson, now: AGORA, desde: '2026-01', indices: ['selic'], executar: true });

      const [selic] = await carregarIndices({
        pool,
        fetchJson: fonte({ '4390': { '2026-02': '0.99' } }).fetchJson,
        now: AGORA,
        desde: '2026-01',
        indices: ['selic'],
        executar: true,
      });

      expect(selic!.inserted).toBe(0);
      expect(selic!.revisions).toEqual([{ period: '2026-02', before: 0.005, after: 0.0099 }]);
      const { rows } = await pool.query("select variation::text from financial_index_points where index_id = 'selic' and period = '2026-02'");
      expect(rows[0].variation).toBe('0.00990000');
    });

    it('janela sem dado no SGS (404) é série vazia naquele trecho, não erro', async () => {
      const semDado = ['2019', '2020'].flatMap((a) => Array.from({ length: 12 }, (_, i) => `7811:${a}-${String(i + 1).padStart(2, '0')}`));
      const { fetchJson, urls } = fonte({}, semDado);
      const [tr] = await carregarIndices({ pool, fetchJson, now: AGORA, desde: '2016-01', indices: ['tr'], executar: false });

      expect(urls.length).toBeGreaterThan(1);
      expect(tr!.points).toBe(128 - 24);
    });

    it('índice sem fonte oficial cadastrada é recusado', async () => {
      await expect(
        carregarIndices({ pool, fetchJson: fonte().fetchJson, now: AGORA, desde: '2025-01', indices: ['cdi'], executar: false }),
      ).rejects.toThrow(/cdi/);
    });

    it('desatualizado enquanto falta a última competência fechada', async () => {
      expect(await indicesDesatualizados(pool, AGORA)).toBe(true);

      await carregarIndices({ pool, fetchJson: fonte().fetchJson, now: AGORA, desde: '2026-01', executar: true });

      expect(await indicesDesatualizados(pool, AGORA)).toBe(false);
      expect(await indicesDesatualizados(pool, new Date('2026-10-25T15:00:00Z'))).toBe(true);
    });

    it('o agendador só busca quando está atrasado, e então só os últimos doze meses', async () => {
      await carregarIndices({ pool, fetchJson: fonte().fetchJson, now: AGORA, desde: '2024-01', executar: true });
      const { fetchJson, urls } = fonte();
      let carregou: (() => void) | undefined;
      const feito = new Promise<void>((r) => (carregou = r));

      const agendador = startIndicesScheduler(pool, {
        fetchJson,
        now: () => new Date('2026-10-25T15:00:00Z'),
        intervalMs: 5,
        onLoad: () => carregou?.(),
      });
      await feito;
      await agendador.stop();

      expect(urls.every((u) => !u.includes('2024') || u.includes('2025'))).toBe(true);
      expect(urls.some((u) => /p\/202508-|dataInicial=01\/08\/2025/.test(u))).toBe(true);
      expect(await indicesDesatualizados(pool, new Date('2026-10-25T15:00:00Z'))).toBe(false);
    });
  });
});
