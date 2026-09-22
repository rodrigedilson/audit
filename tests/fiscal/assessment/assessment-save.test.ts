import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { AssessmentService } from '../../../src/fiscal/assessment/assessment.service.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';
import type { AssessmentResult, TraceLine } from '../../../src/fiscal/assessment/dual-assessment.js';
import { createClient, createTenant, randomCnpj } from '../../helpers/db.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PERIODO = '2027-05';

/**
 * Uma chave de acesso por linha, para o `on conflict` não colapsar as linhas do
 * lote. O teste é sobre a aritmética do batch, e chaves repetidas esconderiam um
 * erro de índice atrás do conflito.
 */
function chave(i: number): string {
  return `3527${String(i).padStart(40, '0')}`;
}

function linha(i: number): TraceLine {
  return {
    accessKey: chave(i),
    line: 1,
    tax: 'icms',
    itemCode: `SKU-${i}`,
    ncm: '73181500',
    direction: i % 2 === 0 ? 'inbound' : 'outbound',
    cst: '00',
    baseCents: 100_000 + i,
    rate: 18,
    amountCents: 18_000 + i,
    origin: 'documento',
  };
}

function resultado(quantasLinhas: number): AssessmentResult {
  const vazio = { debitsCents: 0, potentialCreditsCents: 0, creditableCents: 0, dueCents: 0 };

  return {
    period: PERIODO,
    regime: 'lucro_real',
    legacy: { icms: { ...vazio }, ipi: { ...vazio }, pis: { ...vazio }, cofins: { ...vazio } },
    reform: { ibs_uf: { ...vazio }, ibs_mun: { ...vazio }, cbs: { ...vazio } },
    trace: Array.from({ length: quantasLinhas }, (_, i) => linha(i)),
    notComputable: [],
    documentsConsidered: quantasLinhas,
    itemsConsidered: quantasLinhas,
    coverage: { itemsWithReformGroup: 0, itemsTotal: quantasLinhas },
  };
}

describe.skipIf(!DATABASE_URL)('AssessmentService.save — lote e transação', () => {
  let pool: pg.Pool;
  let scope: EventScope;
  let service: AssessmentService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const tenantId = await createTenant(pool, 'Escritório do lote');
    const cnpj = randomCnpj();
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });

    // `assessments` referencia `periods`: sem a competência aberta o insert
    // falha no FK, antes de chegar no lote que o teste quer exercitar.
    await pool.query(
      `insert into periods (tenant_id, cnpj, period, state)
       values ($1::uuid, $2::char(14), $3::char(7), 'open')`,
      [tenantId, cnpj, PERIODO],
    );

    scope = EventScope.create(tenantId, cnpj);
    service = new AssessmentService(pool);
  });

  const contarLinhas = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from assessment_lines
        where tenant_id = $1::uuid and cnpj = $2::char(14) and period = $3::char(7)`,
      [scope.tenantId, scope.cnpj, PERIODO],
    );
    return Number(rows[0]!.n);
  };

  /**
   * O limite do lote é 500. Testar só abaixo dele deixaria a aritmética de
   * índices do segundo lote sem cobertura — e é ali que um erro de deslocamento
   * apareceria, gravando a coluna errada.
   */
  it.each([1, 499, 500, 501, 1_200])('grava exatamente %i linha(s)', async (quantas) => {
    await service.save(scope, resultado(quantas), 'hash-de-teste', 1);

    expect(await contarLinhas()).toBe(quantas);
  });

  it('a última linha do segundo lote chega com os valores certos', async () => {
    await service.save(scope, resultado(1_200), 'hash-de-teste', 1);

    const { rows } = await pool.query<{
      item_code: string;
      base_cents: string;
      amount_cents: string;
      direction: string;
    }>(
      `select item_code, base_cents, amount_cents, direction
         from assessment_lines
        where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3::char(44)`,
      [scope.tenantId, scope.cnpj, chave(1_199)],
    );

    // Se o deslocamento do lote estivesse errado, estes valores viriam de outra
    // linha — e a contagem total continuaria certa, escondendo o defeito.
    expect(rows[0]).toMatchObject({
      item_code: 'SKU-1199',
      base_cents: '101199',
      amount_cents: '19199',
      direction: 'outbound',
    });
  });

  /**
   * Reapurar substitui a memória de cálculo inteira. Sem o `delete`, as linhas
   * da apuração anterior sobreviveriam ao lado das novas e a memória mostraria o
   * dobro do que a apuração afirma.
   */
  it('reapurar com menos linhas não deixa sobra da apuração anterior', async () => {
    await service.save(scope, resultado(700), 'hash-1', 1);
    expect(await contarLinhas()).toBe(700);

    await service.save(scope, resultado(120), 'hash-2', 2);
    expect(await contarLinhas()).toBe(120);
  });

  /**
   * A razão de `save` ser transacional. Antes usava o pool direto: interrompido
   * no meio, deixava `assessments` afirmando N itens e `assessment_lines` com
   * menos — memória de cálculo incompleta sem nada indicando que estava
   * incompleta. Aconteceu numa apuração real de 2.211 linhas.
   */
  it('falha no meio da gravação não deixa memória de cálculo parcial', async () => {
    await service.save(scope, resultado(600), 'hash-bom', 1);
    expect(await contarLinhas()).toBe(600);

    /**
     * `rate` é `numeric(10,4)`: seis dígitos inteiros é o teto, e 1e7 estoura.
     * A linha escolhida está no SEGUNDO lote de propósito — o primeiro tem de
     * ter sido enviado antes da falha, senão o teste não prova que o rollback
     * desfaz o que já foi gravado.
     */
    const quebrado = resultado(700);
    quebrado.trace[650]!.rate = 10_000_000;

    await expect(service.save(scope, quebrado, 'hash-ruim', 2)).rejects.toThrow();

    // As 600 linhas boas continuam lá: o rollback desfez o delete e os inserts.
    expect(await contarLinhas()).toBe(600);
  });
});
