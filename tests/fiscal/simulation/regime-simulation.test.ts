import { describe, it, expect } from 'vitest';
import {
  simulate,
  regimeComparavel,
  NOT_MODELED,
  REGIMES_COMPARAVEIS,
  type ComparableRegime,
  type SimulationInputs,
} from '../../../src/fiscal/simulation/regime-simulation.js';

/**
 * `base` é mesclada por último, e de propósito: o spread de `override` no fim
 * substituiria a base inteira pelo parcial e os campos ausentes virariam `NaN`
 * — o que já aconteceu ao escrever este arquivo.
 */
function entradas(override: DeepPartial = {}): SimulationInputs {
  const { base, ...resto } = override;

  return {
    scenario: 'full_2033',
    ibsCbsRate: 26,
    simplesEffectiveRate: 10,
    creditableShare: 0.8,
    presumedProfitRate: 32,
    taxLagDaysCurrent: 30,
    taxLagDaysSplitPayment: 0,
    ...resto,
    base: {
      monthlyRevenueCents: 10_000_000,
      monthlyInputsCents: 4_000_000,
      b2bShare: 0.5,
      documentsConsidered: 240,
      monthsConsidered: 12,
      ...(base ?? {}),
    },
  };
}

type DeepPartial = Omit<Partial<SimulationInputs>, 'base'> & {
  base?: Partial<SimulationInputs['base']>;
};

const resultado = (override: DeepPartial = {}) => simulate(entradas(override));

const de = (r: ReturnType<typeof simulate>, regime: ComparableRegime) =>
  r.outcomes.find((o) => o.regime === regime)!;

describe('simulador de regime', () => {
  it('compara os três regimes previstos', () => {
    const r = resultado();

    expect(r.outcomes.map((o) => o.regime).sort()).toEqual([...REGIMES_COMPARAVEIS].sort());
  });

  describe('custo direto e crédito repassável são números diferentes', () => {
    /**
     * A razão de o simulador existir. No integrado a guia é menor — é o que os
     * simuladores genéricos mostram — e o cliente PJ não toma crédito nenhum.
     */
    it('o integrado tem guia menor e nenhum crédito ao cliente PJ', () => {
      const r = resultado();
      const integrado = de(r, 'simples_integrado');
      const presumido = de(r, 'lucro_presumido');

      expect(integrado.directTaxMonthlyCents).toBeLessThan(presumido.directTaxMonthlyCents);
      expect(integrado.creditToB2BCustomersCents).toBe(0);
      expect(presumido.creditToB2BCustomersCents).toBeGreaterThan(0);
    });

    /**
     * O que os genéricos escondem: sem crédito, o cliente PJ exige desconto
     * equivalente, e esse desconto é custo. É o que inverte a comparação.
     */
    it('o custo econômico do integrado inclui o desconto exigido pelo cliente PJ', () => {
      const integrado = de(resultado(), 'simples_integrado');

      expect(integrado.economicCostMonthlyCents).toBeGreaterThan(
        integrado.directTaxMonthlyCents,
      );
      expect(integrado.breakdown['desconto_exigido_pelo_cliente_pj']).toBeGreaterThan(0);
    });

    it('sem receita B2B, o integrado não perde nada por não repassar crédito', () => {
      const integrado = de(resultado({ base: { b2bShare: 0 }  }), 'simples_integrado');

      expect(integrado.economicCostMonthlyCents).toBe(integrado.directTaxMonthlyCents);
      expect(integrado.breakdown['desconto_exigido_pelo_cliente_pj']).toBe(0);
    });

    /** Com toda a receita contra PJ, a perda do crédito é máxima. */
    it('quanto mais B2B, mais caro fica o integrado em custo econômico', () => {
      const pouco = de(resultado({ base: { b2bShare: 0.1 } }), 'simples_integrado');
      const muito = de(resultado({ base: { b2bShare: 0.9 }  }), 'simples_integrado');

      expect(muito.economicCostMonthlyCents).toBeGreaterThan(pouco.economicCostMonthlyCents);
      expect(muito.directTaxMonthlyCents).toBe(pouco.directTaxMonthlyCents);
    });
  });

  describe('crédito de entrada', () => {
    it('reduz o líquido no híbrido e no presumido', () => {
      const semCredito = resultado({ creditableShare: 0 });
      const comCredito = resultado({ creditableShare: 1 });

      for (const regime of ['simples_hibrido', 'lucro_presumido'] as const) {
        expect(de(comCredito, regime).directTaxMonthlyCents).toBeLessThan(
          de(semCredito, regime).directTaxMonthlyCents,
        );
      }
    });

    it('não reduz nada no integrado, onde não há crédito de entrada', () => {
      const semCredito = de(resultado({ creditableShare: 0 }), 'simples_integrado');
      const comCredito = de(resultado({ creditableShare: 1 }), 'simples_integrado');

      expect(comCredito.directTaxMonthlyCents).toBe(semCredito.directTaxMonthlyCents);
    });

    /** Crédito maior que o débito não vira tributo negativo. */
    it('o líquido nunca fica negativo', () => {
      const r = resultado({
        base: { monthlyRevenueCents: 100_000, monthlyInputsCents: 10_000_000 } as never,
        creditableShare: 1,
      });

      for (const outcome of r.outcomes) {
        expect(outcome.directTaxMonthlyCents).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('capital de giro', () => {
    /**
     * A tese do briefing: o impacto está na necessidade de capital de giro, não
     * na DRE. Trinta dias até a guia é financiamento gratuito; sob split payment
     * ele desaparece sem a carga anual mudar uma linha.
     */
    it('split payment cria exposição de capital de giro', () => {
      const r = resultado();

      expect(de(r, 'lucro_presumido').workingCapitalExposureCents).toBeGreaterThan(0);
    });

    it('o integrado mantém o prazo da guia e não tem exposição', () => {
      expect(de(resultado(), 'simples_integrado').workingCapitalExposureCents).toBe(0);
    });

    it('sem folga de prazo hoje, não há o que perder', () => {
      const r = resultado({ taxLagDaysCurrent: 0 });

      for (const outcome of r.outcomes) {
        expect(outcome.workingCapitalExposureCents).toBe(0);
      }
    });

    it('prazo maior hoje significa mais capital de giro a encontrar', () => {
      const trinta = de(resultado({ taxLagDaysCurrent: 30 }), 'lucro_presumido');
      const sessenta = de(resultado({ taxLagDaysCurrent: 60 }), 'lucro_presumido');

      expect(sessenta.workingCapitalExposureCents).toBeGreaterThan(
        trinta.workingCapitalExposureCents,
      );
    });
  });

  describe('vencedor e robustez', () => {
    /**
     * A recusa central da onda: apontar vencedor que depende de uma alíquota
     * não publicada seria dar recomendação com cara de cálculo.
     *
     * Metade da receita contra PJ é justamente a faixa em que a resposta troca
     * com a alíquota — e é o caso comum de um prestador de serviços.
     */
    it('vencedor é null quando ele muda dentro da faixa explorada', () => {
      const r = resultado({ base: { b2bShare: 0.5 } });

      expect(r.robustness).toBe('sensitive');
      expect(r.winner).toBeNull();
    });

    /** Simples caríssimo: o Presumido ganha com qualquer alíquota da faixa. */
    it('vencedor é apontado quando ele não muda em nenhuma célula', () => {
      const r = resultado({ simplesEffectiveRate: 60 });

      expect(r.robustness).toBe('robust');
      expect(r.winner).toBe('lucro_presumido');
      expect(r.annualSavingVsWorstCents).toBeGreaterThan(0);
    });

    /** Sem receita B2B, a perda do crédito repassável não pesa e o integrado ganha. */
    it('sem cliente PJ, o integrado ganha de forma robusta', () => {
      const r = resultado({ base: { b2bShare: 0 } });

      expect(r.robustness).toBe('robust');
      expect(r.winner).toBe('simples_integrado');
    });

    it('as duas coisas andam juntas: robusto tem vencedor, sensível não', () => {
      for (const b2bShare of [0, 0.25, 0.5, 0.75, 1]) {
        const r = resultado({ base: { b2bShare }  });

        expect(r.winner === null).toBe(r.robustness === 'sensitive');
      }
    });

    it('o mapa de sensibilidade cobre alíquotas e frações de crédito', () => {
      const r = resultado();

      expect(r.sensitivity.length).toBe(30);
      expect(new Set(r.sensitivity.map((c) => c.ibsCbsRate)).size).toBe(6);
      expect(new Set(r.sensitivity.map((c) => c.creditableShare)).size).toBe(5);
      for (const celula of r.sensitivity) {
        expect(REGIMES_COMPARAVEIS).toContain(celula.winner);
      }
    });

    /** Um vencedor único no mapa é exatamente a definição de robusto. */
    it('robusto significa vencedor único em todas as células', () => {
      const r = resultado();
      const vencedores = new Set(r.sensitivity.map((c) => c.winner));

      expect(r.robustness === 'robust').toBe(vencedores.size === 1);
    });

    it('a economia contra o pior é anual e nunca negativa', () => {
      const r = resultado();

      expect(r.annualSavingVsWorstCents).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ponto de troca por receita B2B', () => {
    /**
     * É o número que o contador leva para a conversa: "acima de tanto por cento
     * de faturamento para PJ, sair do Simples integrado passa a valer".
     */
    it('encontra a fração em que o vencedor troca', () => {
      const r = resultado();

      expect(r.b2bBreakevenShare).toBeGreaterThan(0);
      expect(r.b2bBreakevenShare).toBeLessThan(1);
    });

    /** Simples mais barato adia o ponto de troca: dá para ter mais PJ e ficar. */
    it('Simples mais barato empurra o ponto de troca para cima', () => {
      const caro = resultado({ simplesEffectiveRate: 10 }).b2bBreakevenShare!;
      const barato = resultado({ simplesEffectiveRate: 2 }).b2bBreakevenShare!;

      expect(barato).toBeGreaterThan(caro);
    });

    it('é null quando o mesmo regime vence de 0 a 100% de B2B', () => {
      // Simples caríssimo: o integrado perde em qualquer fração de B2B.
      const r = resultado({ simplesEffectiveRate: 60 });

      expect(r.b2bBreakevenShare).toBeNull();
    });

    it('o vencedor abaixo e acima do ponto de troca são diferentes', () => {
      const abaixo = resultado({ base: { b2bShare: 0 }  });
      const acima = resultado({ base: { b2bShare: 1 }  });
      const melhorDe = (x: ReturnType<typeof simulate>) =>
        [...x.outcomes].sort(
          (a, b) => a.economicCostMonthlyCents - b.economicCostMonthlyCents,
        )[0]!.regime;

      expect(melhorDe(abaixo)).not.toBe(melhorDe(acima));
    });
  });

  describe('honestidade da saída', () => {
    /**
     * A lista existe porque um simulador sem ela induz o contador a tratar a
     * saída como cálculo. Cada item é uma razão concreta para não decidir só
     * por este número.
     */
    it('declara o que não modela, e a lista é substantiva', () => {
      const r = resultado();

      expect(r.notModeled.length).toBeGreaterThanOrEqual(10);
      expect(r.notModeled.join(' ')).toMatch(/IRPJ e CSLL/);
      expect(r.notModeled.join(' ')).toMatch(/Fator R/);
      expect(r.notModeled.join(' ')).toMatch(/Elasticidade de preço/);
    });

    it('a lista do que não modela não é mutável por fora', () => {
      const r = resultado();
      r.notModeled.push('inventado');

      expect(NOT_MODELED).not.toContain('inventado');
    });

    /**
     * A presunção de lucro é base de IRPJ/CSLL, que está em `NOT_MODELED`.
     * Somá-la ao custo misturaria carga de consumo com carga de renda e faria o
     * Presumido parecer pior do que este simulador tem competência para afirmar.
     */
    it('a presunção de lucro aparece no detalhe mas não entra no custo', () => {
      const presumido = de(resultado(), 'lucro_presumido');

      expect(presumido.breakdown['base_de_presuncao_irpj_csll']).toBeGreaterThan(0);
      expect(presumido.economicCostMonthlyCents).toBe(
        presumido.breakdown['ibs_cbs_liquido'],
      );
    });

    it('cada premissa declara de onde veio', () => {
      const r = resultado();

      expect(r.assumptions.length).toBeGreaterThan(0);
      for (const premissa of r.assumptions) {
        expect(['published', 'measured', 'provided']).toContain(premissa.origin);
        expect(premissa.source.trim().length).toBeGreaterThan(0);
      }
    });

    it('a fração de receita B2B é medida, não perguntada', () => {
      const b2b = resultado().assumptions.find((a) => a.key === 'b2b_share')!;

      expect(b2b.origin).toBe('measured');
      expect(b2b.source).toMatch(/CNPJ na contraparte/);
    });

    it('devolve a base medida junto do resultado, para conferência', () => {
      const r = resultado();

      expect(r.base.documentsConsidered).toBe(240);
      expect(r.base.monthsConsidered).toBe(12);
    });
  });

  describe('valores em centavos inteiros', () => {
    it('nenhum resultado carrega fração de centavo', () => {
      const r = resultado({ ibsCbsRate: 26.37, simplesEffectiveRate: 11.73 });

      for (const outcome of r.outcomes) {
        expect(Number.isInteger(outcome.directTaxMonthlyCents)).toBe(true);
        expect(Number.isInteger(outcome.economicCostMonthlyCents)).toBe(true);
        expect(Number.isInteger(outcome.workingCapitalExposureCents)).toBe(true);
        for (const valor of Object.values(outcome.breakdown)) {
          expect(Number.isInteger(valor)).toBe(true);
        }
      }
    });
  });

  it('regimeComparavel exclui MEI e Lucro Real, que têm regra própria', () => {
    expect(regimeComparavel('simples_hibrido')).toBe(true);
    expect(regimeComparavel('mei')).toBe(false);
    expect(regimeComparavel('lucro_real')).toBe(false);
  });
});
