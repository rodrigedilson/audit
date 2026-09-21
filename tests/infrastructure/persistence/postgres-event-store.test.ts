import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresEventStoreRepository } from '../../../src/infrastructure/persistence/postgres-event-store.repository.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import { EventAppenderService } from '../../../src/esaa/core/event-store/event-appender.service.js';
import { EventReplayerService } from '../../../src/esaa/core/event-store/event-replayer.service.js';
import { FiscalProjectorService } from '../../../src/fiscal/projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../../../src/fiscal/projection/fiscal-hash-verifier.service.js';
import type { EventDraft } from '../../../src/esaa/core/event-store/event-store.repository.js';
import { createClient, createTenant, randomCnpj } from '../../helpers/db.js';
import { TEST_USER_ID } from '../../helpers/scope.js';

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

describe.skipIf(!DATABASE_URL)('PostgresEventStoreRepository', () => {
  let pool: pg.Pool;
  let tenantA: string;
  let tenantB: string;
  let scopeA1: EventScope;
  let scopeA2: EventScope;
  let scopeB1: EventScope;

  const draft = (action: string, taskId: string, scope: EventScope, period?: string): EventDraft => {
    const base: EventDraft = {
      event_id: randomUUID(),
      action: action as EventDraft['action'],
      task_id: taskId,
      actor: TEST_USER_ID,
      ts: new Date().toISOString(),
      schema_version: '0.4.0',
      tenant_id: scope.tenantId,
      cnpj: scope.cnpj,
      payload: { legal_name: 'Cliente de Teste', regime: 'simples_hibrido' } as never,
    };
    return period === undefined ? base : { ...base, period };
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    tenantA = await createTenant(pool, 'Escritório A');
    tenantB = await createTenant(pool, 'Escritório B');
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * Cada teste ganha CNPJs novos, em vez de limpar tabelas compartilhadas: o log
   * nasce vazio (seq começa em 0) sem `truncate`, que apagaria as fixtures dos
   * outros arquivos rodando em paralelo. O mesmo CNPJ é cadastrado nos dois
   * tenants para dar o caso de colisão de CNPJ entre escritórios.
   */
  beforeEach(async () => {
    const cnpj1 = randomCnpj();
    const cnpj2 = randomCnpj();

    await createClient(pool, tenantA, cnpj1);
    await createClient(pool, tenantA, cnpj2);
    await createClient(pool, tenantB, cnpj1);

    scopeA1 = EventScope.create(tenantA, cnpj1);
    scopeA2 = EventScope.create(tenantA, cnpj2);
    scopeB1 = EventScope.create(tenantB, cnpj1);
  });

  it('aloca event_seq a partir de 0 e devolve o evento completo', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);

    const first = await repo.appendNext(draft('client.enrolled', scopeA1.cnpj, scopeA1));
    const second = await repo.appendNext(draft('doc.received', 'chave-1', scopeA1));

    expect(first.event_seq).toBe(0);
    expect(second.event_seq).toBe(1);
    expect(first.tenant_id).toBe(scopeA1.tenantId);
    expect(first.cnpj).toBe(scopeA1.cnpj);
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

    await repo1.appendNext(draft('client.enrolled', scopeA1.cnpj, scopeA1));
    await repo1.appendNext(draft('doc.received', 'chave-1', scopeA1));
    const otherFirst = await repo2.appendNext(draft('client.enrolled', scopeA2.cnpj, scopeA2));

    expect(otherFirst.event_seq).toBe(0);
    expect(await repo1.count()).toBe(2);
    expect(await repo2.count()).toBe(1);
  });

  it('isola tenants que compartilham o mesmo CNPJ', async () => {
    const repoA = new PostgresEventStoreRepository(pool, scopeA1);
    const repoB = new PostgresEventStoreRepository(pool, scopeB1);

    await repoA.appendNext(draft('client.enrolled', scopeA1.cnpj, scopeA1));
    await repoB.appendNext(draft('client.enrolled', scopeB1.cnpj, scopeB1));

    const eventsA = await repoA.getAll();
    const eventsB = await repoB.getAll();

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]!.task_id).toBe(scopeA1.cnpj);
    expect(eventsB[0]!.task_id).toBe(scopeB1.cnpj);
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
        repo.appendNext(draft('doc.received', `chave-${i}`, scopeA1)),
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
      ...Array.from({ length: 10 }, (_, i) => repo1.appendNext(draft('doc.received', `chave-a-${i}`, scopeA1))),
      ...Array.from({ length: 10 }, (_, i) => repo2.appendNext(draft('doc.received', `chave-b-${i}`, scopeA2))),
    ]);

    expect(results).toHaveLength(20);
    expect(await repo1.count()).toBe(10);
    expect(await repo2.count()).toBe(10);
  });

  it('rejeita evento de outro escopo em vez de reescrevê-lo para este log', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);

    await expect(repo.appendNext(draft('client.enrolled', scopeB1.cnpj, scopeB1))).rejects.toThrow(
      /fora do escopo/,
    );
  });

  it('rejeita event_id duplicado (metade nunca verificada de INV-004)', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);
    const first = draft('client.enrolled', scopeA1.cnpj, scopeA1);

    await repo.appendNext(first);

    await expect(repo.appendNext({ ...first, task_id: 'run-002' })).rejects.toThrow(
      /duplicate key|events_event_id_key/,
    );
  });

  it('bloqueia UPDATE e DELETE na tabela de eventos', async () => {
    const repo = new PostgresEventStoreRepository(pool, scopeA1);
    await repo.appendNext(draft('client.enrolled', scopeA1.cnpj, scopeA1));

    await expect(pool.query("update events set actor = 'fraude'")).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from events')).rejects.toThrow(/append-only/);
  });

  describe('fidelidade de ida e volta', () => {
    it('preserva a competência quando presente e a omite quando ausente', async () => {
      const repo = new PostgresEventStoreRepository(pool, scopeA1);

      await repo.appendNext(draft('client.enrolled', scopeA1.cnpj, scopeA1));
      await repo.appendNext(draft('period.opened', '2027-01', scopeA1, '2027-01'));

      const [semPeriodo, comPeriodo] = await repo.getAll();

      expect('period' in semPeriodo!).toBe(false);
      expect(comPeriodo!.period).toBe('2027-01');
    });

    it('devolve event_seq como número, não string do driver', async () => {
      const repo = new PostgresEventStoreRepository(pool, scopeA1);
      for (let i = 0; i < 11; i++) {
        await repo.appendNext(draft('doc.received', `chave-${i}`, scopeA1));
      }

      const events = await repo.getAll();

      expect(events.every((e) => typeof e.event_seq === 'number')).toBe(true);
      // Se viesse string, a ordenação faria '10' < '9' e o replay quebraria.
      expect(events.map((e) => e.event_seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('filtra por task_id e por seq dentro do escopo', async () => {
      const repo = new PostgresEventStoreRepository(pool, scopeA1);
      await repo.appendNext(draft('client.enrolled', scopeA1.cnpj, scopeA1));
      await repo.appendNext(draft('doc.received', 'chave-1', scopeA1));
      await repo.appendNext(draft('doc.manifested', 'chave-1', scopeA1));

      expect(await repo.getByTaskId('chave-1')).toHaveLength(2);
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
      action: 'client.enrolled',
      taskId: scopeA1.cnpj,
      actor: TEST_USER_ID,
      payload: { legal_name: 'Cliente de Teste', regime: 'simples_hibrido' },
    });
    await appender.append({
      action: 'period.opened',
      taskId: '2027-01',
      actor: TEST_USER_ID,
      payload: { period: '2027-01' },
      period: '2027-01',
    });

    const events = await new EventReplayerService(repo).replayAll();
    const projector = new FiscalProjectorService();
    const projection = projector.project(scopeA1.tenantId, scopeA1.cnpj, events);

    expect(events).toHaveLength(2);
    expect(projection.last_event_seq).toBe(1);
    expect(projection.client?.legal_name).toBe('Cliente de Teste');
    expect(projection.periods['2027-01']?.state).toBe('open');

    const verification = new FiscalHashVerifierService(projector).verify(events, projection);
    expect(verification.valid).toBe(true);

    // Reprojetar a partir de uma segunda leitura do banco tem de dar o mesmo hash.
    const reread = await new EventReplayerService(repo).replayAll();
    expect(
      projector.project(scopeA1.tenantId, scopeA1.cnpj, reread).projection_hash_sha256,
    ).toBe(projection.projection_hash_sha256);
  });
});
