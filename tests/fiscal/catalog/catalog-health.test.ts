import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { CatalogService } from '../../../src/fiscal/catalog/catalog.service.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';

/**
 * `reference_tables_loaded` e o `notice`, sem tocar no banco compartilhado.
 *
 * Estas asserções viviam num teste de integração que fazia
 * `delete from fiscal_codes` para produzir o caso "tabela vazia". Essas tabelas
 * são **globais** — não têm coluna de tenant —, o vitest roda arquivos em
 * paralelo, e o delete esvaziava a tabela para todos os outros arquivos durante
 * a execução. `reporting.test.ts` já se defendia lendo a contagem antes de
 * afirmar, o que é sinal de que a corrida era conhecida; a defesa ainda deixava
 * uma janela entre ler e afirmar.
 *
 * O que se quer verificar é a lógica de `health()`, e ela não precisa de banco:
 * um pool falso devolve as contagens e o resto é aritmética. A rota continua
 * coberta pelos testes de integração, com as tabelas carregadas.
 */
function poolFalso(porTipo: Record<string, number>): Pool {
  return {
    query: (sql: string) => {
      if (sql.includes('from fiscal_codes group by kind')) {
        return Promise.resolve({
          rows: Object.entries(porTipo).map(([kind, n]) => ({ kind, n: String(n) })),
        });
      }
      if (sql.includes('item_propagation')) {
        return Promise.resolve({ rows: [{ outbound: '0', inbound: '0', valor: '0' }] });
      }
      if (sql.includes("issue->>'message'")) {
        return Promise.resolve({
          rows: [{ reason: 'NCM não verificado: tabela de referência não carregada.', total: '3' }],
        });
      }
      // Resumo dos itens.
      return Promise.resolve({
        rows: [{ total: '3', ok: '0', warning: '3', error: '0', nunca: '0' }],
      });
    },
  } as unknown as Pool;
}

const ESCOPO = EventScope.create('11111111-1111-1111-1111-111111111111', '12345678000195');

const TODOS_CARREGADOS = {
  ncm: 10_515,
  nbs: 920,
  cfop: 238,
  cst_icms: 25,
  cst_pis_cofins: 33,
  cst_ibs_cbs: 18,
  cclasstrib: 164,
  cclasstrib_cst_pares: 164,
};

describe('CatalogService.health — tabelas de referência', () => {
  it('sem nenhuma tabela, avisa que ausência de erro não é correção', async () => {
    const saude = await new CatalogService(poolFalso({})).health(ESCOPO);

    expect(saude.reference_tables_loaded).toBe(false);
    expect(saude.not_verified).toBeGreaterThan(0);
    for (const total of Object.values(saude.reference_tables)) {
      expect(total).toBe(0);
    }
  });

  /**
   * O caso que a carga de CFOP criou: um tipo carregado e os outros vazios. O
   * booleano continua falso — um tipo conferido não autoriza dizer que ausência
   * de erro significa correção, porque o item pode estar errado justamente no
   * tipo que ninguém verificou.
   */
  it('um tipo carregado não liga o booleano, e aparece na contagem por tipo', async () => {
    const saude = await new CatalogService(poolFalso({ cfop: 238 })).health(ESCOPO);

    expect(saude.reference_tables_loaded).toBe(false);
    expect(saude.reference_tables['cfop']).toBe(238);
    expect(saude.reference_tables['ncm']).toBe(0);
  });

  it('com os sete tipos e os pares, o booleano liga', async () => {
    const saude = await new CatalogService(poolFalso(TODOS_CARREGADOS)).health(ESCOPO);

    expect(saude.reference_tables_loaded).toBe(true);
  });

  /** Falta só o pareamento: a incompatibilidade CST × cClassTrib fica inverificável. */
  it('sem os pares, o booleano não liga mesmo com os sete tipos', async () => {
    const semPares = { ...TODOS_CARREGADOS, cclasstrib_cst_pares: 0 };

    const saude = await new CatalogService(poolFalso(semPares)).health(ESCOPO);

    expect(saude.reference_tables_loaded).toBe(false);
  });
});
