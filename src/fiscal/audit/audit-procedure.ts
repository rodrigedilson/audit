import type { Classification, NcmFlags } from '../catalog/code-validation.js';
import type { CreditState, Regime } from '../shared/fiscal-vocabulary.js';
import type { Verification } from './verifications.js';

/**
 * Trilha executável: uma conferência com população declarada, técnica de
 * exame, verificações e critério vinculado.
 *
 * Difere do que `reporting/audit-trails.ts` já chama de trilha, e as duas
 * convivem porque fazem coisas diferentes. Lá é um **agregador passivo**: pega
 * o que por acaso foi rejeitado pelo pipeline e agrupa em checagens nomeadas
 * para o Book. Aqui é um **executor ativo**: define a população, examina cada
 * sujeito contra um critério e produz achado com impacto em centavos. O
 * agregador passa a consumir estes achados como mais uma origem, e nada do que
 * ele já faz precisa mudar de lugar.
 */

export const SAMPLING_TECHNIQUES = [
  /**
   * Padrão. O sistema tem todos os XMLs, então amostrar é descartar dado que já
   * está no banco — e obriga o contador a extrapolar na hora de defender o
   * achado. É o contraste direto com quem amostra.
   */
  'censo',
  'aleatoria_simples',
  'por_relevancia',
] as const;
export type SamplingTechnique = (typeof SAMPLING_TECHNIQUES)[number];

export interface SamplingPlan {
  technique: SamplingTechnique;
  /** `null` em censo: não há tamanho de amostra, há população. */
  size: number | null;
  /** Corte de valor em `por_relevancia`. */
  thresholdCents: number | null;
  /** Semente do sorteio, para o exame ser reproduzível. */
  seed: string | null;
  /**
   * Obrigatória quando a técnica não é censo. Amostrar tendo a população
   * inteira precisa de motivo escrito, senão vira preguiça com nome técnico.
   */
  justification: string | null;
}

export function censo(): SamplingPlan {
  return { technique: 'censo', size: null, thresholdCents: null, seed: null, justification: null };
}

export const POPULATION_KINDS = [
  'documentos_de_entrada',
  'documentos_de_saida',
  'itens_do_catalogo',
  'creditos_de_entrada',
] as const;
export type PopulationKind = (typeof POPULATION_KINDS)[number];

export const REVERSAL_POLICIES = [
  /** Distorção relevante autoriza **propor** estorno. Efetivar é ato humano. */
  'propor_estorno',
  /**
   * A distorção existe e o estorno não cabe porque o lançamento é do Fisco, e
   * não nosso — débito com prazo próximo, por exemplo. Produz achado e alerta.
   */
  'somente_achado',
] as const;
export type ReversalPolicy = (typeof REVERSAL_POLICIES)[number];

export interface AuditProcedure {
  procedureId: string;
  name: string;
  description: string;
  population: PopulationKind;
  sampling: SamplingPlan;
  /** Quais das cinco esta trilha executa. Ordem significativa. */
  verifications: readonly Verification[];
  criterionId: string;
  /** `null` = vale para todos os regimes. */
  appliesToRegimes: readonly Regime[] | null;
  reversalPolicy: ReversalPolicy;
  active: boolean;
}

/**
 * O sujeito examinado, já materializado pelo repositório.
 *
 * Record largo, e não união discriminada por tipo de população: as trilhas se
 * sobrepõem muito, e a união obrigaria o repositório a saber qual variante
 * montar para cada uma. Campo que a origem não sabe vem `null`, e `null` é o
 * que faz a verificação sair `not_verified` em vez de `pass`.
 */
export interface ExaminableSubject {
  subject: string;
  subjectKind: PopulationKind;

  // ------------------------------------------------------------- documento
  accessKey: string | null;
  issuerCnpj: string | null;
  recipientCnpj: string | null;
  /** `YYYY-MM-DD`. */
  issuedAt: string | null;
  /** Competência derivada da emissão. */
  documentPeriod: string | null;
  /** Protocolo de autorização da SEFAZ. `null` = não coletado. */
  authorizationProtocol: string | null;
  /** `null` quando a ingestão não sabe dizer — não é o mesmo que `false`. */
  cancelled: boolean | null;
  denied: boolean | null;

  // ---------------------------------------------------------- apropriação
  /** Competência em que o documento foi apropriado na apuração. */
  appropriatedPeriod: string | null;

  // --------------------------------------------------------- classificação
  classification: Classification | null;
  ncmFlags: NcmFlags | null;
  cnaePrimary: string | null;
  /**
   * Declaração do contador sobre a destinação do item. `null` enquanto o
   * cadastro não tiver o campo: **não existe tabela oficial que derive
   * insumo × uso e consumo a partir do NCM**, porque a LC 214 define pela
   * atividade, e não pela mercadoria. A trilha audita a declaração contra o
   * crédito tomado; ela nunca inventa a classificação.
   */
  usageKind: 'insumo' | 'uso_e_consumo' | null;

  // ---------------------------------------------------------- crédito
  creditState: CreditState | null;
  /** Valor em jogo no sujeito, em centavos. */
  amountCents: number;
}
