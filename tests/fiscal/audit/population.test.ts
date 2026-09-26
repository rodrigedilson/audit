import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { PopulationRepository } from '../../../src/fiscal/audit/population.js';
import { emptyCodeTables, type CodeTables } from '../../../src/fiscal/catalog/code-validation.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';

const SCOPE = EventScope.create('11111111-1111-1111-1111-111111111111', '12345678000195');
const PERIODO = '2027-03';

/** Pool dublado: devolve as linhas pedidas e guarda o que foi consultado. */
function poolCom(linhas: Record<string, unknown>[]): { pool: Pool; chamadas: unknown[][] } {
  const chamadas: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      chamadas.push([sql, params]);
      return { rows: linhas };
    },
  } as unknown as Pool;
  return { pool, chamadas };
}

const tabelasCom = (ncm: string, monophasic: boolean): CodeTables => ({
  ...emptyCodeTables(),
  ncm: new Set([ncm]),
  ncmFlags: new Map([[ncm, { monophasic, taxSubstitution: false }]]),
});

const credito = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_key: '35270811222333000181550010000000151234567890',
  issuer_cnpj: '11222333000181',
  counterparty_cnpj: null,
  issued_at: new Date('2027-02-10T12:00:00Z'),
  document_period: '2027-02',
  appropriated_period: PERIODO,
  total_cents: '250000',
  cancelled_at: null,
  cancel_protocol: '135270000000001',
  cnae_primary: '4771701',
  single_ncm: '30049099',
  ...over,
});

describe('população — créditos de entrada', () => {
  it('traz a competência de apropriação da EFD, separada da de emissão', async () => {
    const { pool } = poolCom([credito()]);

    const [s] = await new PopulationRepository(pool).creditosDeEntrada(SCOPE, PERIODO, emptyCodeTables());

    expect(s!.documentPeriod).toBe('2027-02');
    expect(s!.appropriatedPeriod).toBe(PERIODO);
  });

  /**
   * A regressão que este módulo corrige: sem EFD a apropriação era copiada da
   * emissão, e a verificação 2 passava sempre por comparar a data com ela mesma.
   */
  it('sem EFD, a apropriação vem null — não copiada da emissão', async () => {
    const { pool } = poolCom([credito({ appropriated_period: null, document_period: PERIODO })]);

    const [s] = await new PopulationRepository(pool).creditosDeEntrada(SCOPE, PERIODO, emptyCodeTables());

    expect(s!.documentPeriod).toBe(PERIODO);
    expect(s!.appropriatedPeriod).toBeNull();
  });

  it('leva o CNAE do cliente e as marcações do NCM único da nota', async () => {
    const { pool } = poolCom([credito()]);

    const [s] = await new PopulationRepository(pool).creditosDeEntrada(
      SCOPE,
      PERIODO,
      tabelasCom('30049099', true),
    );

    expect(s!.cnaePrimary).toBe('4771701');
    expect(s!.ncmFlags).toEqual({ monophasic: true, taxSubstitution: false });
  });

  it('nota com vários NCMs não ganha marcação: atribuir uma seria escolher', async () => {
    const { pool } = poolCom([credito({ single_ncm: null })]);

    const [s] = await new PopulationRepository(pool).creditosDeEntrada(
      SCOPE,
      PERIODO,
      tabelasCom('30049099', true),
    );

    expect(s!.ncmFlags).toBeNull();
  });

  it('o que a origem não sabe continua null: denegação, destinação e classificação', async () => {
    const { pool } = poolCom([credito()]);

    const [s] = await new PopulationRepository(pool).creditosDeEntrada(SCOPE, PERIODO, emptyCodeTables());

    expect(s!.denied).toBeNull();
    expect(s!.usageKind).toBeNull();
    expect(s!.classification).toBeNull();
    expect(s!.cancelled).toBe(false);
    expect(s!.amountCents).toBe(250_000);
  });

  it('cancelamento coletado vira cancelled=true', async () => {
    const { pool } = poolCom([credito({ cancelled_at: new Date('2027-03-02T00:00:00Z') })]);

    const [s] = await new PopulationRepository(pool).creditosDeEntrada(SCOPE, PERIODO, emptyCodeTables());

    expect(s!.cancelled).toBe(true);
  });

  it('consulta só o escopo pedido', async () => {
    const { pool, chamadas } = poolCom([]);

    await new PopulationRepository(pool).creditosDeEntrada(SCOPE, PERIODO, emptyCodeTables());

    expect(chamadas[0]![1]).toEqual([SCOPE.tenantId, SCOPE.cnpj, PERIODO]);
  });
});

describe('população — itens do catálogo', () => {
  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    item_id: 'SKU-1',
    amount_cents: '90000',
    effective_from: '2027-01',
    ncm: '30049099',
    nbs: null,
    cst_ibs_cbs: '000',
    cclasstrib: null,
    cst_icms: null,
    cst_pis_cofins: '04',
    cfop_default: '5102',
    justification: null,
    cnae_primary: '4771701',
    ...over,
  });

  it('um sujeito por item, com a classificação vigente e sem campos nulos', async () => {
    const { pool } = poolCom([item()]);

    const [s] = await new PopulationRepository(pool).itensDoCatalogo(SCOPE, PERIODO, emptyCodeTables());

    expect(s!.subject).toBe('SKU-1');
    expect(s!.subjectKind).toBe('itens_do_catalogo');
    expect(s!.classification).toEqual({
      effectiveFrom: '2027-01',
      ncm: '30049099',
      cstIbsCbs: '000',
      cstPisCofins: '04',
      cfopDefault: '5102',
    });
    expect(s!.amountCents).toBe(90_000);
    // Item não é crédito: o achado não mexe em saldo.
    expect(s!.creditState).toBeNull();
  });

  it('item nunca classificado vem com classification null', async () => {
    const { pool } = poolCom([item({ effective_from: null, ncm: null, cst_ibs_cbs: null })]);

    const [s] = await new PopulationRepository(pool).itensDoCatalogo(SCOPE, PERIODO, emptyCodeTables());

    expect(s!.classification).toBeNull();
    expect(s!.ncmFlags).toBeNull();
  });
});

describe('população — despacho pelo tipo da trilha', () => {
  it('itens_do_catalogo não recebe documentos', async () => {
    const { pool, chamadas } = poolCom([]);

    await new PopulationRepository(pool).load(SCOPE, PERIODO, 'itens_do_catalogo', emptyCodeTables());

    expect(String(chamadas[0]![0])).toContain('item_classifications');
  });

  it('população sem leitura implementada falha em vez de examinar outra coisa', async () => {
    const { pool } = poolCom([]);

    await expect(
      new PopulationRepository(pool).load(SCOPE, PERIODO, 'documentos_de_saida', emptyCodeTables()),
    ).rejects.toThrow(/documentos_de_saida/);
  });
});
