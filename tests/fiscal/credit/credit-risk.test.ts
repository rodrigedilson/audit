import { describe, it, expect } from 'vitest';
import {
  aggregateBySupplier,
  classifyCredits,
  DIAS_PARA_RISCO,
  type CreditInput,
} from '../../../src/fiscal/credit/credit-risk.js';

const CHAVE = '35270912345678000195550010000000011234567893';
const FORNECEDOR = '98765432000199';
const HOJE = new Date('2027-12-01T12:00:00Z');

function entrada(override: Partial<CreditInput> = {}): CreditInput {
  return {
    accessKey: CHAVE,
    period: '2027-11',
    tax: 'cbs',
    supplierCnpj: FORNECEDOR,
    supplierName: 'FORNECEDOR LTDA',
    amountCents: 92_100,
    issuedAt: '2027-11-20T10:00:00Z',
    hasReformGroup: true,
    ...override,
  };
}

const um = (override: Partial<CreditInput> = {}) => classifyCredits([entrada(override)], HOJE)[0]!;

describe('estado do crédito de entrada', () => {
  /**
   * Crédito do sistema antigo nasce do documento e não depende de liquidação
   * nenhuma. Tratá-lo como condicionado reportaria risco onde não há, e o
   * escritório aprenderia a ignorar o alerta.
   */
  it.each(['icms', 'ipi', 'pis', 'cofins'] as const)(
    'crédito de %s não é condicionado a liquidação',
    (tax) => {
      const posicao = um({ tax });

      expect(posicao.state).toBe('expected');
      expect(posicao.reason).toMatch(/nasce do documento/);
      expect(posicao.unpaidDays).toBeNull();
    },
  );

  it.each(['cbs', 'ibs_uf', 'ibs_mun'] as const)('crédito de %s é condicionado', (tax) => {
    expect(um({ tax, issuedAt: '2027-11-28T10:00:00Z' }).state).toBe('conditioned');
  });

  it('documento sem grupo IBS/CBS não tem crédito da reforma a condicionar', () => {
    const posicao = um({ hasReformGroup: false });

    expect(posicao.state).toBe('expected');
    expect(posicao.reason).toMatch(/não traz o grupo IBS\/CBS/);
  });

  describe('sem pagamento identificado', () => {
    it('fica condicionado enquanto é recente, com o motivo da condição', () => {
      const posicao = um({ issuedAt: '2027-11-28T10:00:00Z' });

      expect(posicao.state).toBe('conditioned');
      expect(posicao.reason).toMatch(/depende da extinção do tributo da etapa anterior/);
      expect(posicao.unpaidDays).toBe(3);
    });

    /**
     * O achado que o produto vende: sem liquidação não há split payment, e sem
     * split payment o tributo da etapa anterior não se extingue. Nosso
     * não-pagamento é o sinal de risco que o sistema consegue observar.
     */
    it('vira at_risk ao envelhecer, e o motivo explica a cadeia', () => {
      const emitida = new Date(HOJE);
      emitida.setUTCDate(emitida.getUTCDate() - DIAS_PARA_RISCO);

      const posicao = um({ issuedAt: emitida.toISOString() });

      expect(posicao.state).toBe('at_risk');
      expect(posicao.reason).toMatch(/Sem liquidação não há split payment/);
      expect(posicao.unpaidDays).toBe(DIAS_PARA_RISCO);
    });

    it('um dia antes do limiar ainda é condicionado, não em risco', () => {
      const emitida = new Date(HOJE);
      emitida.setUTCDate(emitida.getUTCDate() - (DIAS_PARA_RISCO - 1));

      expect(um({ issuedAt: emitida.toISOString() }).state).toBe('conditioned');
    });

    it('data de emissão ilegível não vira risco por acidente', () => {
      const posicao = um({ issuedAt: 'não é data' });

      expect(posicao.state).toBe('conditioned');
      expect(posicao.unpaidDays).toBeNull();
    });
  });

  describe('com pagamento identificado', () => {
    /**
     * A honestidade central da onda. Nós pagamos, mas não temos como observar
     * que o tributo do fornecedor foi extinguido — e chamar isso de liberado
     * seria exatamente a afirmação que o Fisco depois glosaria.
     */
    it.each(['exact', 'amount_and_date'] as const)(
      'pagamento com confiança %s NÃO libera o crédito',
      (confidence) => {
        const posicao = um({ payment: { confidence, postedAt: '2027-11-25' } });

        expect(posicao.state).toBe('conditioned');
        expect(posicao.state).not.toBe('released');
        expect(posicao.reason).toMatch(/não tem como observar/);
        expect(posicao.reason).toMatch(/recolhimento de terceiro/);
      },
    );

    it('pagamento identificado zera os dias sem pagar', () => {
      const posicao = um({
        issuedAt: '2027-01-01T10:00:00Z',
        payment: { confidence: 'exact', postedAt: '2027-01-15' },
      });

      expect(posicao.unpaidDays).toBeNull();
      expect(posicao.state).toBe('conditioned');
    });

    /**
     * Promover hipótese fraca a crédito aproveitável seria aproveitar crédito
     * com base num casamento que o próprio sistema classificou como incerto.
     */
    it.each(['amount_only', 'ambiguous'] as const)(
      'casamento %s é reportado como incerto, não como pagamento feito',
      (confidence) => {
        const posicao = um({ payment: { confidence, postedAt: '2027-11-25' } });

        expect(posicao.state).toBe('conditioned');
        expect(posicao.reason).toMatch(/casamento é incerto/);
      },
    );

    it('o motivo nomeia o grau de confiança em português', () => {
      expect(um({ payment: { confidence: 'exact', postedAt: '2027-11-25' } }).reason).toMatch(
        /identificada no histórico/,
      );
      expect(
        um({ payment: { confidence: 'ambiguous', postedAt: '2027-11-25' } }).reason,
      ).toMatch(/mais de um documento candidato/,);
    });
  });

  /** Estado sem motivo é opaco: o contador não tem como contestar nem confiar. */
  it('toda posição carrega motivo não vazio', () => {
    const posicoes = classifyCredits(
      [
        entrada({ tax: 'icms' }),
        entrada({ hasReformGroup: false }),
        entrada(),
        entrada({ issuedAt: '2027-01-01T10:00:00Z' }),
        entrada({ payment: { confidence: 'exact', postedAt: '2027-11-25' } }),
        entrada({ payment: { confidence: 'ambiguous', postedAt: '2027-11-25' } }),
      ],
      HOJE,
    );

    expect(posicoes).toHaveLength(6);
    for (const posicao of posicoes) {
      expect(posicao.reason.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * `released` exige evidência de extinção do tributo da etapa anterior, e não
   * há fonte para ela hoje. Nenhum caminho de entrada deve produzi-lo — se um
   * dia produzir, é porque a fonte entrou, e isso é uma decisão consciente.
   */
  it('nenhuma combinação de entradas produz released', () => {
    const combinacoes: CreditInput[] = [];

    for (const tax of ['cbs', 'ibs_uf', 'ibs_mun', 'icms', 'pis'] as const) {
      for (const hasReformGroup of [true, false]) {
        // Recente e antiga: sem a antiga, o espaço de estados não chegaria a
        // `at_risk` e o teste passaria sem cobrir o caminho que interessa.
        for (const issuedAt of ['2027-11-20T10:00:00Z', '2027-06-01T10:00:00Z']) {
          for (const payment of [
            undefined,
            { confidence: 'exact' as const, postedAt: '2027-11-25' },
            { confidence: 'amount_and_date' as const, postedAt: '2027-11-25' },
            { confidence: 'amount_only' as const, postedAt: '2027-11-25' },
            { confidence: 'ambiguous' as const, postedAt: '2027-11-25' },
          ]) {
            combinacoes.push(
              entrada({
                tax,
                hasReformGroup,
                issuedAt,
                ...(payment === undefined ? {} : { payment }),
              }),
            );
          }
        }
      }
    }

    const estados = new Set(classifyCredits(combinacoes, HOJE).map((p) => p.state));

    expect(estados.has('released')).toBe(false);
    expect(estados.has('lost')).toBe(false);
    expect(estados).toEqual(new Set(['expected', 'conditioned', 'at_risk']));
  });

  it('preserva a identidade do fornecedor e o valor em cada posição', () => {
    const posicao = um();

    expect(posicao.supplierCnpj).toBe(FORNECEDOR);
    expect(posicao.supplierName).toBe('FORNECEDOR LTDA');
    expect(posicao.amountCents).toBe(92_100);
    expect(posicao.hasReformGroup).toBe(true);
  });
});

describe('risco por fornecedor', () => {
  const posicoes = (...entradas: CreditInput[]) => classifyCredits(entradas, HOJE);

  it('soma por estado e conta documentos distintos', () => {
    const r = aggregateBySupplier(
      posicoes(
        entrada({ tax: 'cbs', amountCents: 10_000, issuedAt: '2027-11-28T10:00:00Z' }),
        entrada({ tax: 'ibs_uf', amountCents: 1_000, issuedAt: '2027-11-28T10:00:00Z' }),
        entrada({ tax: 'icms', amountCents: 50_000 }),
      ),
    );

    expect(r).toHaveLength(1);
    expect(r[0]!.documents).toBe(1);
    expect(r[0]!.creditConditionedCents).toBe(11_000);
    expect(r[0]!.creditExpectedCents).toBe(50_000);
  });

  /** A ordem é a fila de trabalho do escritório: maior risco primeiro. */
  it('ordena por crédito em risco, e depois por condicionado', () => {
    const outro = '11222333000144';
    const antiga = '2027-06-01T10:00:00Z';

    const r = aggregateBySupplier(
      posicoes(
        entrada({ amountCents: 5_000, issuedAt: '2027-11-28T10:00:00Z' }),
        entrada({
          supplierCnpj: outro,
          supplierName: 'OUTRO',
          amountCents: 1_000,
          issuedAt: antiga,
        }),
      ),
    );

    expect(r[0]!.supplierCnpj).toBe(outro);
    expect(r[0]!.creditAtRiskCents).toBe(1_000);
    expect(r[1]!.creditConditionedCents).toBe(5_000);
  });

  it('o mais antigo sem pagar é o maior número de dias do fornecedor', () => {
    const r = aggregateBySupplier(
      posicoes(
        entrada({ issuedAt: '2027-11-28T10:00:00Z' }),
        entrada({ accessKey: `${CHAVE.slice(0, 43)}0`, issuedAt: '2027-09-01T10:00:00Z' }),
      ),
    );

    expect(r[0]!.oldestUnpaidDays).toBe(91);
  });

  it('todo documento pago deixa o fornecedor sem dias em aberto', () => {
    const r = aggregateBySupplier(
      posicoes(entrada({ payment: { confidence: 'exact', postedAt: '2027-11-25' } })),
    );

    expect(r[0]!.oldestUnpaidDays).toBeNull();
  });

  /**
   * `emitsReformGroup` diz o que o sistema observa — se os documentos trazem o
   * grupo UB — e não se o fornecedor usa split payment, que é operação de
   * terceiro e não está ao alcance do produto.
   */
  it('emitsReformGroup reflete os documentos, não uma conclusão sobre o fornecedor', () => {
    const com = aggregateBySupplier(posicoes(entrada({ hasReformGroup: true })));
    const sem = aggregateBySupplier(posicoes(entrada({ hasReformGroup: false })));

    expect(com[0]!.emitsReformGroup).toBe(true);
    expect(sem[0]!.emitsReformGroup).toBe(false);
  });

  it('um documento com grupo entre vários sem já marca o fornecedor', () => {
    const r = aggregateBySupplier(
      posicoes(
        entrada({ hasReformGroup: false }),
        entrada({ accessKey: `${CHAVE.slice(0, 43)}0`, hasReformGroup: true }),
      ),
    );

    expect(r[0]!.emitsReformGroup).toBe(true);
  });

  it('separa fornecedores diferentes e mantém o nome de cada um', () => {
    const r = aggregateBySupplier(
      posicoes(
        entrada(),
        entrada({ supplierCnpj: '11222333000144', supplierName: 'SEGUNDO LTDA' }),
      ),
    );

    expect(r).toHaveLength(2);
    expect(r.map((f) => f.supplierName).sort()).toEqual(['FORNECEDOR LTDA', 'SEGUNDO LTDA']);
  });

  it('nome nulo em um documento não apaga o nome vindo de outro', () => {
    const r = aggregateBySupplier(
      posicoes(
        entrada({ supplierName: null }),
        entrada({ accessKey: `${CHAVE.slice(0, 43)}0`, supplierName: 'FORNECEDOR LTDA' }),
      ),
    );

    expect(r[0]!.supplierName).toBe('FORNECEDOR LTDA');
  });

  it('sem posição nenhuma, não há fornecedor', () => {
    expect(aggregateBySupplier([])).toHaveLength(0);
  });
});
