import type { Pool } from 'pg';
import type { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { Regime } from '../shared/fiscal-vocabulary.js';
import {
  simulate,
  type Assumption,
  type ComparableRegime,
  type MeasuredBase,
  type Scenario,
  type SimulationInputs,
  type SimulationResult,
} from './regime-simulation.js';

export interface SimulationOverrides {
  ibs_cbs_rate?: number;
  simples_effective_rate?: number;
  creditable_share?: number;
  presumed_profit_rate?: number;
  tax_lag_days_current?: number;
  b2b_share?: number;
}

export interface SimulationRequest {
  scenario: Scenario;
  base_from: string;
  base_to: string;
  overrides?: SimulationOverrides;
}

export interface StoredSimulation {
  id: string;
  scenario: Scenario;
  base_from: string;
  base_to: string;
  winner: ComparableRegime | null;
  robustness: 'robust' | 'sensitive';
  simulated_at: string;
  result: SimulationResult;
}

export class SimulationNotPossibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationNotPossibleError';
  }
}

/**
 * Valores de referência das premissas **não publicadas**.
 *
 * Deliberadamente não são "o valor da alíquota": são ponto de partida para o
 * usuário mexer, e todo um deles sai marcado como `provided` no relatório. A
 * alíquota de referência do IBS/CBS citada por terceiros no briefing não foi
 * conferida em texto oficial, e embuti-la como padrão faria o produto entregar
 * projeção com cara de cálculo.
 *
 * Quando `tax_rules` tiver a alíquota publicada, ela é usada e a premissa passa
 * a `published` com o `rule_id` na fonte.
 */
const PARTIDA = {
  ibsCbsRate: 26,
  simplesEffectiveRate: 10,
  creditableShare: 0.8,
  presumedProfitRate: 32,
  taxLagDaysCurrent: 30,
} as const;

/**
 * Simulador de regime — diferencial #8.
 *
 * Somente leitura: o serviço não recebe orquestrador, então não há caminho de
 * código daqui até o log fiscal. A simulação é gravada em tabela própria, que é
 * registro de aconselhamento e não apuração.
 */
export class SimulationService {
  constructor(private readonly pool: Pool) {}

  async run(
    scope: EventScope,
    request: SimulationRequest,
    simulatedBy: string | null,
  ): Promise<StoredSimulation> {
    const base = await this.measureBase(scope, request);

    if (base.documentsConsidered === 0) {
      throw new SimulationNotPossibleError(
        `Nenhum documento entre ${request.base_from} e ${request.base_to}. O simulador ` +
          'projeta sobre os dados reais da carteira — sem documento, qualquer número ' +
          'seria inventado.',
      );
    }

    // `tax_rules` é dado normativo global, não por escritório: sem escopo.
    const publicada = await this.loadPublishedRate();
    const overrides = request.overrides ?? {};

    const inputs: SimulationInputs = {
      scenario: request.scenario,
      base:
        overrides.b2b_share === undefined
          ? base
          : { ...base, b2bShare: overrides.b2b_share },
      ibsCbsRate: overrides.ibs_cbs_rate ?? publicada?.rate ?? PARTIDA.ibsCbsRate,
      simplesEffectiveRate:
        overrides.simples_effective_rate ?? PARTIDA.simplesEffectiveRate,
      creditableShare: overrides.creditable_share ?? PARTIDA.creditableShare,
      presumedProfitRate: overrides.presumed_profit_rate ?? PARTIDA.presumedProfitRate,
      taxLagDaysCurrent: overrides.tax_lag_days_current ?? PARTIDA.taxLagDaysCurrent,
      // Sob split payment o tributo sai na liquidação: não há prazo nenhum.
      taxLagDaysSplitPayment: 0,
    };

    const resultado = simulate(inputs);
    resultado.assumptions = [
      ...resultado.assumptions,
      ...this.declararPremissas(inputs, overrides, publicada),
    ];

    const { rows } = await this.pool.query<{ id: string; simulated_at: string }>(
      `insert into simulations (
         tenant_id, cnpj, scenario, base_from, base_to, inputs, result,
         winner, robustness, simulated_by
       ) values ($1::uuid, $2::char(14), $3, $4::char(7), $5::char(7),
                 $6::jsonb, $7::jsonb, $8::regime, $9, $10::uuid)
       returning id, simulated_at`,
      [
        scope.tenantId,
        scope.cnpj,
        request.scenario,
        request.base_from,
        request.base_to,
        JSON.stringify(inputs),
        JSON.stringify(resultado),
        resultado.winner,
        resultado.robustness,
        simulatedBy,
      ],
    );

    return {
      id: rows[0]!.id,
      scenario: request.scenario,
      base_from: request.base_from,
      base_to: request.base_to,
      winner: resultado.winner,
      robustness: resultado.robustness,
      simulated_at: new Date(rows[0]!.simulated_at).toISOString(),
      result: resultado,
    };
  }

  async list(scope: EventScope): Promise<StoredSimulation[]> {
    const { rows } = await this.pool.query(
      `select id, scenario, base_from, base_to, winner, robustness, simulated_at, result
         from simulations
        where tenant_id = $1::uuid and cnpj = $2::char(14)
        order by simulated_at desc
        limit 50`,
      [scope.tenantId, scope.cnpj],
    );

    return rows.map((r: Record<string, unknown>) => ({
      id: String(r['id']),
      scenario: r['scenario'] as Scenario,
      base_from: String(r['base_from']).trim(),
      base_to: String(r['base_to']).trim(),
      winner: (r['winner'] ?? null) as ComparableRegime | null,
      robustness: r['robustness'] as 'robust' | 'sensitive',
      simulated_at: new Date(String(r['simulated_at'])).toISOString(),
      result: r['result'] as SimulationResult,
    }));
  }

  // ------------------------------------------------------------ medição

  /**
   * A base vem **medida dos documentos**, não perguntada.
   *
   * A fração de receita contra PJ é o número que decide se a perda do crédito
   * repassável dói, e é justamente o que o cliente não sabe responder de cabeça.
   * Medi-la nas notas de saída é o que torna esta simulação diferente de uma
   * planilha.
   */
  private async measureBase(
    scope: EventScope,
    request: SimulationRequest,
  ): Promise<MeasuredBase> {
    const { rows } = await this.pool.query<{
      saida: string;
      entrada: string;
      saida_pj: string;
      documentos: string;
      meses: string;
    }>(
      `select coalesce(sum(total_cents) filter (where direction = 'outbound'), 0)::text as saida,
              coalesce(sum(total_cents) filter (where direction = 'inbound'), 0)::text  as entrada,
              coalesce(sum(total_cents) filter (
                where direction = 'outbound' and counterparty_cnpj is not null
              ), 0)::text as saida_pj,
              count(*)::text as documentos,
              count(distinct period)::text as meses
         from documents
        where tenant_id = $1::uuid and cnpj = $2::char(14)
          and period >= $3::char(7) and period <= $4::char(7)`,
      [scope.tenantId, scope.cnpj, request.base_from, request.base_to],
    );

    const linha = rows[0]!;
    const saida = Number(linha.saida);
    const meses = Math.max(1, Number(linha.meses));

    return {
      monthlyRevenueCents: Math.round(saida / meses),
      monthlyInputsCents: Math.round(Number(linha.entrada) / meses),
      // Sem receita de saída, a fração é zero e não uma divisão por zero.
      b2bShare: saida === 0 ? 0 : Number(linha.saida_pj) / saida,
      documentsConsidered: Number(linha.documentos),
      monthsConsidered: meses,
    };
  }

  /**
   * Alíquota de referência publicada, se houver.
   *
   * `tax_rules` nasce vazia de propósito (Onda 6), então o normal é não haver —
   * e nesse caso a premissa aparece como `provided`, com a nota de que o valor
   * é ponto de partida e não norma.
   */
  private async loadPublishedRate(): Promise<{ rate: number; source: string } | undefined> {
    /**
     * A alíquota conjunta é a soma das publicadas para IBS-UF, IBS-Mun e CBS.
     * Somar é necessário porque a norma publica cada uma em separado, e o
     * simulador compara com uma alíquota conjunta — mas só vale como publicada
     * se **todas as três** existirem: somar duas daria um número menor com cara
     * de completo.
     */
    const { rows } = await this.pool.query<{ tax: string; value: string; source: string }>(
      `select distinct on (tax) tax, value, source
         from tax_rules
        where kind = 'rate' and tax in ('ibs_uf', 'ibs_mun', 'cbs')
          and valid_from <= current_date
          and (valid_to is null or valid_to >= current_date)
        order by tax, valid_from desc`,
    );

    if (rows.length < 3) {
      return undefined;
    }

    return {
      rate: rows.reduce((soma, r) => soma + Number(r.value), 0),
      source: [...new Set(rows.map((r) => r.source))].join('; '),
    };
  }

  /**
   * Declara a origem de cada premissa.
   *
   * É a peça que separa cálculo de chute: o relatório diz, premissa por
   * premissa, se o número veio de norma publicada, de medição na carteira ou de
   * quem pediu a simulação.
   */
  private declararPremissas(
    inputs: SimulationInputs,
    overrides: SimulationOverrides,
    publicada: { rate: number; source: string } | undefined,
  ): Assumption[] {
    const aliquotaPublicada = publicada !== undefined && overrides.ibs_cbs_rate === undefined;

    const saida: Assumption[] = [
      {
        key: 'ibs_cbs_rate',
        label: 'Alíquota de referência IBS + CBS',
        value: inputs.ibsCbsRate,
        unit: 'percent',
        origin: aliquotaPublicada ? 'published' : 'provided',
        source: aliquotaPublicada
          ? `alíquotas publicadas de IBS-UF, IBS-Mun e CBS somadas — fonte: ${publicada!.source}`
          : 'ponto de partida, não norma: a alíquota de referência não está ' +
            'publicada em texto oficial conferido. Ajuste e veja o mapa de ' +
            'sensibilidade.',
      },
      {
        key: 'simples_effective_rate',
        label: 'Alíquota efetiva do Simples sobre a receita',
        value: inputs.simplesEffectiveRate,
        unit: 'percent',
        origin: 'provided',
        source:
          'depende do anexo e da faixa de RBT12, e o anexo depende do Fator R — ' +
          'que exige folha de pagamento, dado que este sistema não tem.',
      },
      {
        key: 'creditable_share',
        label: 'Fração das compras que gera crédito aproveitável',
        value: inputs.creditableShare,
        unit: 'ratio',
        origin: 'provided',
        source:
          'não medida: depende de classificação de item e de regime específico, ' +
          'e está no mapa de sensibilidade justamente por isso.',
      },
      {
        key: 'presumed_profit_rate',
        label: 'Presunção de lucro do Lucro Presumido',
        value: inputs.presumedProfitRate,
        unit: 'percent',
        origin: 'provided',
        source: 'informativa: base de IRPJ/CSLL, que não entra no custo comparado.',
      },
      {
        key: 'tax_lag_days_current',
        label: 'Dias entre o faturamento e o vencimento da guia hoje',
        value: inputs.taxLagDaysCurrent,
        unit: 'days',
        origin: 'provided',
        source: 'é a folga de caixa que o split payment elimina.',
      },
    ];

    if (overrides.b2b_share !== undefined) {
      saida.push({
        key: 'b2b_share_override',
        label: 'Fração da receita contra PJ (informada, substituindo a medida)',
        value: overrides.b2b_share,
        unit: 'ratio',
        origin: 'provided',
        source: 'informada na requisição; a medida na carteira foi substituída.',
      });
    }

    return saida;
  }
}

/** Regimes que o simulador não compara, com o motivo para a tela mostrar. */
export const REGIMES_FORA: Readonly<Partial<Record<Regime, string>>> = {
  mei: 'O MEI tem limite de receita e regra própria; a comparação não se aplica.',
  lucro_real:
    'O Lucro Real depende de apuração de resultado, que este simulador não faz — ' +
    'ver a lista do que não é modelado.',
};
