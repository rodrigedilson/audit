import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { PostgresEventStoreRepository } from '../../../src/infrastructure/persistence/postgres-event-store.repository.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import { EventAppenderService } from '../../../src/esaa/core/event-store/event-appender.service.js';
import { EventReplayerService } from '../../../src/esaa/core/event-store/event-replayer.service.js';
import { ProjectorService } from '../../../src/esaa/core/projection/projector.service.js';
import { HashVerifierService } from '../../../src/esaa/core/projection/hash-verifier.service.js';
import type { EventDraft } from '../../../src/esaa/core/event-store/event-store.repository.js';

/**
 * Estes testes exigem Postgres. Sem `TEST_DATABASE_URL` a suíte é pulada em vez
 * de falhar, para que `npm test` funcione numa máquina sem banco; o CI define a
 * variável e então eles rodam de verdade.
 *
 * Subir um local:
 *   docker run -d --name audit-pg -e POSTGRES_PASSWORD=audit -e POSTGRES_USER=audit \
 *     -e POSTGRES_DB=audit_test -p 55432:5432 postgres:16-alpine
 *   export TEST_DATABASE_URL=postgres://audit:audit@localhost:55432/audit_test
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'];

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CNPJ_1 = '12345678000195';
const CNPJ_2 = '11222333000181';

describe.skipIf(!DATABASE_URL)('PostgresEventStoreRepository', () => {
  let pool: pg.Pool;
  let scopeA1: EventScope;
  let scopeA2: EventScope;
  let scopeB1: EventScope;

  const draft = (action: string, taskId: string, scope: EventScope, period?: string): EventDraft => {
    const base: EventDraft = {
      event_id: randomUUID(),
      action: action as EventDraft['action'],
      task_id: taskId,
      actor: 'tech-lead',
      ts: new Date().toISOString(),
      schema_version: '0.4.0',
      tenant_id: scope.tenantId,
      cnpj: scope.cnpj,
      payload: { run_id: 'run-001', phase_name: 'Fechamento', objectives: [] } as never,
    };
    return period === undefined ? base : { ...base, period };
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    const migration = await readFile(
      join(process.cwd(), 'supabase/migrations/20260918120000_multi_tenancy.sql'),
      'utf8',
    );
    await pool.query(migration);

    scopeA1 = EventScope.create(TENANT_A, CNPJ_1);
    scopeA2 = EventScope.create(TENANT_A, CNPJ_2);
    scopeB1 = EventScope.create(TENANT_B, CNPJ_1);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // O trigger append-only bloqueia DELETE, então a limpeza usa TRUNCATE, que
    // não dispara trigger de linha.
    await pool.query('truncate table events, periods, clients, memberships, tenants cascade');

    for (const [id, name] of [
      [TENANT_A, 'Escritório A'],
      [TENANT_B, 'Escritório B'],
    ] as const) {
      await pool.query('insert into tenants (id, name) values ($1, $2)', [id, name]);
    }
    for (const [tenant, cnpj] of [
      [TENANT_A, CNPJ_1],
      [TENANT_A, CNPJ_2],
      [TENANT_B, CNPJ_1],
    ] as const) {
      await pool.query(
        `insert into clients (tenant_id, cnpj, legal_name, regime)
         values ($1, $2, $3, 'simples_hibrido')`,
        [tenant, cnpj, `Cliente ${cnpj}`],
      );
    }
  });

  it('aloca event_seq a partir de 0 e devolve o evento completo', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);

    const first = await repo.appendNext(draft('run.start', 'run-001', scopeA1));
    const second = await repo.appendNext(draft('task.create', 'T-1', scopeA1));

    expect(first.event_seq).toBe(0);
    expect(second.event_seq).toBe(1);
    expect(first.tenant_id).toBe(TENANT_A);
    expect(first.cnpj).toBe(CNPJ_1);
    expect(await repo.getLastSeq()).toBe(1);
  });

  it('devolve -1 em getLastSeq para log vazio, como a porta exige', async () => {
    expect(await new PostgresEventStoreRepository(pool, scopeA1).getLastSeq()).toBe(-1);
  });

  /**
   * A sequência é por CNPJ e não global: se fosse global, dois CNPJs do mesmo
   * escritório disputariam a mesma sequência e não poderiam fechar em paralelo.
   */
  it('mantém sequências independentes por CNPJ dentro do mesmo tenant', async () => {
    const repo1 = new PostgresEventStoreRepository(pool, scopeA1);
    const repo2 = new PostgresEventStoreRepository(pool, scopeA2);

    await repo1.appendNext(draft('run.start', 'run-001', scopeA1));
    await repo1.appendNext(draft('task.create', 'T-1', scopeA1));
    const otherFirst = await repo2.appendNext(draft('run.start', 'run-001', scopeA2));

    expect(otherFirst.event_seq).toBe(0);
    expect(await repo1.count()).toBe(2);
    expect(await repo2.count()).toBe(1);
  });

  it('isola tenants que compartilham o mesmo CNPJ', async () => {
    const repoA = new PostgresEventStoreRepository(pool, scopeA1);
    const repoB = new PostgresEventStoreRepository(pool, scopeB1);

    await repoA.appendNext(draft('run.start', 'run-a', scopeA1));
    await repoB.appendNext(draft('run.start', 'run-b', scopeB1));

    const eventsA = await repoA.getAll();
    const eventsB = await repoB.getAll();

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]!.task_id).toBe('run-a');
    expect(eventsB[0]!.task_id).toBe('run-b');
    // Ambos começam em 0: a sequência é do par, não de um contador compartilhado.
    expect(eventsA[0]!.event_seq).toBe(0);
    expect(eventsB[0]!.event_seq).toBe(0);
  });

  /**
   * Este é o teste de INV-005. Com a alocação antiga — `getLastSeq()` + 1 +
   * append em JavaScript — escritas concorrentes colidiriam no mesmo seq. O
   * advisory lock por CNPJ dentro da transação é o que faz a sequência sair
   * densa e sem repetição.
   */
  it('serializa escritas concorrentes no mesmo CNPJ, sem gap nem duplicata', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);
    const total = 40;

    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        repo.appendNext(draft('task.create', `T-${i}`, scopeA1)),
      ),
    );

    const seqs = results.map((e) => e.event_seq).sort((a, b) => a - b);

    expect(new Set(seqs).size).toBe(total);
    expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('não serializa CNPJs diferentes entre si', async () => {
    const repo1 = new PostgresEventStoreRepository(pool, scopeA1);
    const repo2 = new PostgresEventStoreRepository(pool, scopeA2);

    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => repo1.appendNext(draft('task.create', `A-${i}`, scopeA1))),
      ...Array.from({ length: 10 }, (_, i) => repo2.appendNext(draft('task.create', `B-${i}`, scopeA2))),
    ]);

    expect(results).toHaveLength(20);
    expect(await repo1.count()).toBe(10);
    expect(await repo2.count()).toBe(10);
  });

  it('rejeita evento de outro escopo em vez de reescrevê-lo para este log', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);

    await expect(repo.appendNext(draft('run.start', 'run-x', scopeB1))).rejects.toThrow(
      /fora do escopo/,
    );
  });

  it('rejeita event_id duplicado (metade nunca verificada de INV-004)', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);
    const first = draft('run.start', 'run-001', scopeA1);

    await repo.appendNext(first);

    await expect(repo.appendNext({ ...first, task_id: 'run-002' })).rejects.toThrow(
      /duplicate key|events_event_id_key/,
    );
  });

  it('bloqueia UPDATE e DELETE na tabela de eventos', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);
    await repo.appendNext(draft('run.start', 'run-001', scopeA1));

    await expect(pool.query("update events set actor = 'fraude'")).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from events')).rejects.toThrow(/append-only/);
  });

  describe('fidelidade de ida e volta', () => {
    it('preserva a competência quando presente e a omite quando ausente', async () => {
      const repo = new PostgresEventStoreRepository(pool, scopeA1);

      await repo.appendNext(draft('run.start', 'run-001', scopeA1));
      await repo.appendNext(draft('task.create', 'T-1', scopeA1, '2027-01'));

      const [semPeriodo, comPeriodo] = await repo.getAll();

      expect('period' in semPeriodo!).toBe(false);
      expect(comPeriodo!.period).toBe('2027-01');
    });

    it('devolve event_seq como número, não string do driver', async () => {
      const repo = new PostgresEventStoreRepository(pool, scopeA1);
      for (let i = 0; i < 11; i++) {
        await repo.appendNext(draft('task.create', `T-${i}`, scopeA1));
      }

      const events = await repo.getAll();

      expect(events.every((e) => typeof e.event_seq === 'number')).toBe(true);
      // Se viesse string, a ordenação faria '10' < '9' e o replay quebraria.
      expect(events.map((e) => e.event_seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('filtra por task_id e por seq dentro do escopo', async () => {
      const repo = new PostgresEventStoreRepository(pool, scopeA1);
      await repo.appendNext(draft('run.start', 'run-001', scopeA1));
      await repo.appendNext(draft('task.create', 'T-1', scopeA1));
      await repo.appendNext(draft('claim', 'T-1', scopeA1));

      expect(await repo.getByTaskId('T-1')).toHaveLength(2);
      expect(await repo.getAfterSeq(0)).toHaveLength(2);
    });
  });

  /**
   * O kernel inteiro tem de funcionar sobre o adapter novo sem alteração: é o que
   * valida a promessa do ADR-003 de que a porta `IEventStoreRepository` era o
   * ponto de extensão certo.
   */
  it('o replay determinístico funciona sobre Postgres (INV-006)', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);
    const appender = new EventAppenderService(repo, scopeA1);

    await appender.append({
      action: 'run.start',
      taskId: 'run-001',
      actor: 'tech-lead',
      payload: { run_id: 'run-001', phase_name: 'Fechamento', objectives: [] },
    });
    await appender.append({
      action: 'task.create',
      taskId: 'T-1000',
      actor: 'tech-lead',
      payload: {
        kind: 'impl',
        description: 'Apurar',
        assigned_agent: 'coder',
        parent_run: 'run-001',
      },
      period: '2027-01',
    });

    const events = await new EventReplayerService(repo).replayAll();
    const projector = new ProjectorService();
    const roadmap = projector.project(events);

    expect(events).toHaveLength(2);
    expect(roadmap.last_event_seq).toBe(1);

    const verification = new HashVerifierService(projector).verify(events, roadmap);
    expect(verification.valid).toBe(true);

    // Reprojetar a partir de uma segunda leitura do banco tem de dar o mesmo hash.
    const reread = await new EventReplayerService(repo).replayAll();
    expect(projector.project(reread).projection_hash_sha256).toBe(roadmap.projection_hash_sha256);
  });
});
