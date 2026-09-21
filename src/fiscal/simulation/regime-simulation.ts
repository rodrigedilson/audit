import type { Regime } from '../shared/fiscal-vocabulary.js';

/**
 * Simulador Integrado × Híbrido × Presumido — diferencial #8.
 *
 * Somente leitura: **não grava evento fiscal nenhum**. Compara cenários, e
 * escolher regime é decisão do contador.
 *
 * Duas coisas que os simuladores genéricos não fazem, e que são a razão de este
 * existir:
 *
 * 1. **Custo tributário direto e crédito repassável ao cliente PJ são números
 *    diferentes.** No Simples integrado o IBS/CBS fica dentro do DAS e o cliente
 *    PJ **não** toma crédito; para ganhar a concorrência, o fornecedor precisa
 *    descontar o preço. O custo real da escolha é maior do que a guia paga, e um
 *    simulador que só compara guias esconde exatamente isso.
 * 2. **O impacto está na necessidade de capital de giro, não na DRE.** Sob split
 *    payment o tributo sai do caixa na liquidação, e não no dia 20 do mês
 *    seguinte. A carga anual pode ser igual e o caixa, não.
 *
 * E uma recusa: quando o regime vencedor muda dentro da faixa de premissas
 * explorada, o resultado é `winner: null` com `robustness: 'sensitive'`. Apontar
 * um vencedor que depende de uma alíquota não publicada seria dar recomendação
 * com cara de cálculo.
 */

export type Scenario = 'transition_2027_2028' | 'full_2033';

/** Regimes que o simulador compara. MEI e Lucro Real ficam fora — ver `NOT_MODELED`. */
export const REGIMES_COMPARAVEIS = [
  'simples_integrado',
  'simples_hibrido',
  'lucro_presumido',
] as const;

export type ComparableRegime = (typeof REGIMES_COMPARAVEIS)[number];

/** De onde cada premissa veio. É o que separa cálculo de chute. */
export type AssumptionOrigin =
  /** Regra publicada em `tax_rules`, com fonte normativa. */
  | 'published'
  /** Dado real da carteira do cliente, medido nos documentos. */
  | 'measured'
  /** Informado por quem simula. É premissa, e o relatório diz isso. */
  | 'provided';

export interface Assumption {
  key: string;
  label: string;
  value: number;
  unit: 'percent' | 'brl' | 'days' | 'ratio';
  origin: AssumptionOrigin;
  /** `rule_id` quando publicado; nota de premissa quando informado. */
  source: string;
}

/** Medidas tiradas dos documentos reais. Nenhuma é estimada. */
export interface MeasuredBase {
  /** Receita mensal média, das notas de saída. */
  monthlyRevenueCents: number;
  /** Compras mensais médias, das notas de entrada. */
  monthlyInputsCents: number;
  /**
   * Fração da receita faturada contra PJ.
   *
   * Medida: documento de saída com CNPJ na contraparte. É o número que decide se
   * a perda do crédito repassável dói ou não, e é por isso que ele é medido e
   * não perguntado.
   */
  b2bShare: number;
  documentsConsidered: number;
  monthsConsidered: number;
}

export interface SimulationInputs {
  scenario: Scenario;
  base: MeasuredBase;
  /** Alíquota conjunta de referência IBS+CBS, em pontos percentuais. */
  ibsCbsRate: number;
  /** Alíquota efetiva do Simples sobre a receita, em pontos percentuais. */
  simplesEffectiveRate: number;
  /** Fração das compras que gera crédito aproveitável. */
  creditableShare: number;
  /** Presunção de lucro do Presumido, em pontos percentuais da receita. */
  presumedProfitRate: number;
  /**
   * Dias entre o faturamento e a saída do tributo do caixa.
   *
   * No regime atual, o prazo até o vencimento da guia. Sob split payment, zero:
   * o tributo é retido na liquidação. É essa diferença que vira capital de giro.
   */
  taxLagDaysCurrent: number;
  taxLagDaysSplitPayment: number;
}

export interface RegimeOutcome {
  regime: ComparableRegime;
  /** O que sai do caixa por mês. */
  directTaxMonthlyCents: number;
  /**
   * Crédito que o cliente PJ pode aproveitar.
   *
   * **Não reduz a guia.** É vantagem competitiva: sem ele, o cliente PJ exige
   * desconto equivalente, e o valor vira perda de receita.
   */
  creditToB2BCustomersCents: number;
  /**
   * Custo econômico: guia + o desconto que o cliente PJ vai exigir por não ter
   * crédito. É o número que compara regimes de verdade.
   */
  economicCostMonthlyCents: number;
  /** Capital de giro exigido pelo adiantamento do tributo. */
  workingCapitalExposureCents: number;
  breakdown: Record<string, number>;
}

export interface SensitivityCell {
  ibsCbsRate: number;
  creditableShare: number;
  winner: ComparableRegime;
}

export interface SimulationResult {
  scenario: Scenario;
  base: MeasuredBase;
  outcomes: RegimeOutcome[];
  /** `null` quando o vencedor muda dentro da faixa explorada. */
  winner: ComparableRegime | null;
  robustness: 'robust' | 'sensitive';
  /** Economia anual do vencedor contra o pior, em custo econômico. */
  annualSavingVsWorstCents: number;
  /**
   * Fração de receita B2B em que o vencedor troca. `null` quando não há troca
   * dentro de 0 a 100%.
   */
  b2bBreakevenShare: number | null;
  sensitivity: SensitivityCell[];
  assumptions: Assumption[];
  notModeled: string[];
}

/**
 * O que a simulação **não** modela.
 *
 * Copiado em espírito da página de metodologia do simuleareforma, que o briefing
 * cita como bom exemplo: a lista existe porque um simulador sem ela induz o
 * contador a tratar a saída como cálculo. Cada item aqui é uma razão concreta
 * para não decidir só por este número.
 */
export const NOT_MODELED: readonly string[] = [
  'IRPJ e CSLL. O simulador compara a carga sobre o consumo; a carga total de ' +
    'um Lucro Presumido inclui tributo sobre a renda que não entra nesta conta.',
  'Folha de pagamento e Fator R. O sistema não tem dado de folha, e o Fator R ' +
    'decide o anexo do Simples — é pré-requisito do regime híbrido.',
  'Reduções setoriais e regimes específicos da LC 214 (saúde, educação, ' +
    'transporte, imóveis, entre outros).',
  'Monofásico e substituição tributária na composição do preço.',
  'ICMS-ST e DIFAL do sistema atual.',
  'Crédito presumido e incentivos estaduais.',
  'Elasticidade de preço: a simulação assume preço constante. Se o mercado ' +
    'absorver parte do tributo, o resultado muda.',
  'Sazonalidade além da média do período medido.',
  'O cronograma do ADCT ano a ano além do que as premissas declararem.',
  'MEI e Lucro Real. O primeiro tem limite de receita e regra própria; o ' +
    'segundo depende de apuração de resultado que este simulador não faz.',
];

/** Faixa de sensibilidade explorada: alíquotas e frações de crédito. */
const ALIQUOTAS_EXPLORADAS = [20, 22, 24, 26, 28, 30] as const;
const FRACOES_DE_CREDITO = [0, 0.25, 0.5, 0.75, 1] as const;

export function simulate(inputs: SimulationInputs): SimulationResult {
  const outcomes = REGIMES_COMPARAVEIS.map((regime) => simularRegime(regime, inputs));

  const sensitivity = mapaDeSensibilidade(inputs);
  const vencedores = new Set(sensitivity.map((c) => c.winner));
  const robusto = vencedores.size === 1;

  const melhor = [...outcomes].sort(
    (a, b) => a.economicCostMonthlyCents - b.economicCostMonthlyCents,
  )[0]!;
  const pior = [...outcomes].sort(
    (a, b) => b.economicCostMonthlyCents - a.economicCostMonthlyCents,
  )[0]!;

  return {
    scenario: inputs.scenario,
    base: inputs.base,
    outcomes,
    // Apontar vencedor que depende de alíquota não publicada seria dar
    // recomendação com cara de cálculo.
    winner: robusto ? melhor.regime : null,
    robustness: robusto ? 'robust' : 'sensitive',
    annualSavingVsWorstCents:
      (pior.economicCostMonthlyCents - melhor.economicCostMonthlyCents) * 12,
    b2bBreakevenShare: pontoDeTroca(inputs),
    sensitivity,
    assumptions: premissas(inputs),
    notModeled: [...NOT_MODELED],
  };
}

function simularRegime(regime: ComparableRegime, inputs: SimulationInputs): RegimeOutcome {
  const { base } = inputs;
  const receita = base.monthlyRevenueCents;
  const compras = base.monthlyInputsCents;

  switch (regime) {
    case 'simples_integrado':
      return integrado(receita, inputs);
    case 'simples_hibrido':
      return hibrido(receita, compras, inputs);
    case 'lucro_presumido':
      return presumido(receita, compras, inputs);
  }
}

/**
 * Simples integrado: IBS/CBS dentro do DAS.
 *
 * A guia é menor, e é isso que os simuladores mostram. O que eles não mostram: o
 * cliente PJ não toma crédito nenhum, então parte da receita B2B precisa de
 * desconto equivalente ao crédito que ele perderia. Esse desconto é custo, e sem
 * ele o fornecedor perde o cliente.
 */
// Sem parâmetro de compras de propósito: no Simples integrado não há crédito de
// entrada a aproveitar, e receber o valor aqui sugeriria que ele entra na conta.
function integrado(receita: number, inputs: SimulationInputs): RegimeOutcome {
  const das = arredondar(receita * (inputs.simplesEffectiveRate / 100));

  // O crédito que o cliente PJ deixa de tomar, e que ele vai querer de volta no
  // preço. Medido sobre a receita B2B, porque só o cliente PJ toma crédito.
  const creditoPerdidoPeloCliente = arredondar(
    receita * inputs.base.b2bShare * (inputs.ibsCbsRate / 100),
  );

  return {
    regime: 'simples_integrado',
    directTaxMonthlyCents: das,
    creditToB2BCustomersCents: 0,
    economicCostMonthlyCents: das + creditoPerdidoPeloCliente,
    workingCapitalExposureCents: capitalDeGiro(das, inputs.taxLagDaysCurrent, inputs),
    breakdown: {
      das,
      credito_ao_cliente_pj: 0,
      desconto_exigido_pelo_cliente_pj: creditoPerdidoPeloCliente,
      credito_de_entrada_aproveitado: 0,
    },
  };
}

/**
 * Simples híbrido: IBS/CBS fora do DAS.
 *
 * Paga IBS/CBS por fora e aproveita crédito de entrada, e o cliente PJ toma
 * crédito integral. A guia total é maior e o custo econômico pode ser menor —
 * é exatamente a inversão que a separação dos dois números revela.
 */
function hibrido(receita: number, compras: number, inputs: SimulationInputs): RegimeOutcome {
  // No híbrido o DAS cobre só os tributos que não migraram.
  const dasReduzido = arredondar(receita * (inputs.simplesEffectiveRate / 100) * 0.6);
  const debito = arredondar(receita * (inputs.ibsCbsRate / 100));
  const credito = arredondar(compras * inputs.creditableShare * (inputs.ibsCbsRate / 100));
  const liquido = Math.max(0, debito - credito);

  const creditoAoCliente = arredondar(
    receita * inputs.base.b2bShare * (inputs.ibsCbsRate / 100),
  );

  return {
    regime: 'simples_hibrido',
    directTaxMonthlyCents: dasReduzido + liquido,
    creditToB2BCustomersCents: creditoAoCliente,
    economicCostMonthlyCents: dasReduzido + liquido,
    workingCapitalExposureCents: capitalDeGiro(
      dasReduzido + liquido,
      inputs.taxLagDaysSplitPayment,
      inputs,
    ),
    breakdown: {
      das_reduzido: dasReduzido,
      ibs_cbs_debito: debito,
      ibs_cbs_credito: credito,
      ibs_cbs_liquido: liquido,
      credito_ao_cliente_pj: creditoAoCliente,
    },
  };
}

function presumido(receita: number, compras: number, inputs: SimulationInputs): RegimeOutcome {
  const debito = arredondar(receita * (inputs.ibsCbsRate / 100));
  const credito = arredondar(compras * inputs.creditableShare * (inputs.ibsCbsRate / 100));
  const liquido = Math.max(0, debito - credito);

  const creditoAoCliente = arredondar(
    receita * inputs.base.b2bShare * (inputs.ibsCbsRate / 100),
  );

  /**
   * A presunção de lucro entra no `breakdown` como informação, e **não** no
   * custo: ela é base de IRPJ/CSLL, que estão em `NOT_MODELED`. Somá-la aqui
   * misturaria carga de consumo com carga de renda e faria o Presumido parecer
   * pior do que este simulador tem competência para afirmar.
   */
  const baseDePresuncao = arredondar(receita * (inputs.presumedProfitRate / 100));

  return {
    regime: 'lucro_presumido',
    directTaxMonthlyCents: liquido,
    creditToB2BCustomersCents: creditoAoCliente,
    economicCostMonthlyCents: liquido,
    workingCapitalExposureCents: capitalDeGiro(
      liquido,
      inputs.taxLagDaysSplitPayment,
      inputs,
    ),
    breakdown: {
      ibs_cbs_debito: debito,
      ibs_cbs_credito: credito,
      ibs_cbs_liquido: liquido,
      credito_ao_cliente_pj: creditoAoCliente,
      base_de_presuncao_irpj_csll: baseDePresuncao,
    },
  };
}

/**
 * Capital de giro exigido pelo tributo.
 *
 * É a tese que o briefing destaca: o impacto da reforma está na necessidade de
 * capital de giro, não na DRE. Um prazo de 30 dias até a guia é financiamento
 * gratuito; sob split payment ele desaparece, e a empresa precisa desse dinheiro
 * em caixa sem que a carga anual tenha mudado uma linha.
 */
function capitalDeGiro(
  tributoMensal: number,
  diasDeFolga: number,
  inputs: SimulationInputs,
): number {
  const perdaDeFolga = inputs.taxLagDaysCurrent - diasDeFolga;
  if (perdaDeFolga <= 0) {
    return 0;
  }
  return arredondar((tributoMensal * perdaDeFolga) / 30);
}

// -------------------------------------------------------- sensibilidade

/**
 * Mapa alíquota × fração de crédito, com o regime vencedor em cada célula.
 *
 * Existe para mostrar **de que a resposta depende**. Com alíquota não publicada,
 * um número único seria uma opinião disfarçada; o mapa transforma a incerteza em
 * informação.
 */
function mapaDeSensibilidade(inputs: SimulationInputs): SensitivityCell[] {
  const celulas: SensitivityCell[] = [];

  for (const ibsCbsRate of ALIQUOTAS_EXPLORADAS) {
    for (const creditableShare of FRACOES_DE_CREDITO) {
      const variacao: SimulationInputs = { ...inputs, ibsCbsRate, creditableShare };
      const melhor = REGIMES_COMPARAVEIS.map((r) => simularRegime(r, variacao)).sort(
        (a, b) => a.economicCostMonthlyCents - b.economicCostMonthlyCents,
      )[0]!;

      celulas.push({ ibsCbsRate, creditableShare, winner: melhor.regime });
    }
  }

  return celulas;
}

/**
 * Fração de receita B2B em que o vencedor troca.
 *
 * É o número que o contador leva para a conversa: "acima de tanto por cento de
 * faturamento para PJ, sair do Simples integrado passa a valer".
 */
function pontoDeTroca(inputs: SimulationInputs): number | null {
  const vencedorEm = (b2bShare: number): ComparableRegime =>
    REGIMES_COMPARAVEIS.map((r) =>
      simularRegime(r, { ...inputs, base: { ...inputs.base, b2bShare } }),
    ).sort((a, b) => a.economicCostMonthlyCents - b.economicCostMonthlyCents)[0]!.regime;

  const emZero = vencedorEm(0);
  if (vencedorEm(1) === emZero) {
    return null;
  }

  // Busca binária em 1 ponto percentual: mais fino do que isso é precisão falsa
  // sobre uma premissa que já é estimada.
  let baixo = 0;
  let alto = 1;
  while (alto - baixo > 0.01) {
    const meio = (baixo + alto) / 2;
    if (vencedorEm(meio) === emZero) {
      baixo = meio;
    } else {
      alto = meio;
    }
  }

  return Math.round(alto * 100) / 100;
}

function premissas(inputs: SimulationInputs): Assumption[] {
  return [
    {
      key: 'monthly_revenue',
      label: 'Receita mensal média',
      value: inputs.base.monthlyRevenueCents,
      unit: 'brl',
      origin: 'measured',
      source: `${inputs.base.documentsConsidered} documento(s) em ${inputs.base.monthsConsidered} mês(es)`,
    },
    {
      key: 'b2b_share',
      label: 'Fração da receita faturada contra PJ',
      value: inputs.base.b2bShare,
      unit: 'ratio',
      origin: 'measured',
      source: 'notas de saída com CNPJ na contraparte',
    },
  ];
}

/** Centavos inteiros: fração de centavo em projeção é precisão falsa. */
function arredondar(valor: number): number {
  return Math.round(valor);
}

/** Regimes fora da comparação, com o motivo. */
export function regimeComparavel(regime: Regime): regime is ComparableRegime {
  return (REGIMES_COMPARAVEIS as readonly string[]).includes(regime);
}
