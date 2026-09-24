/**
 * Critério de avaliação: o parâmetro contra o qual uma rejeição foi julgada.
 *
 * Vem da doutrina de perícia contábil, onde o teste de comprovação e inspeção
 * documentária só conclui alguma coisa se estiver vinculado a um critério —
 * "um princípio (fonte, modelo, padrão ou standard) tomado como referência para
 * julgar algo", derivado de legislação, regulamento, norma técnica, contrato,
 * súmula ou precedente. Sem ele, o exame produz opinião; com ele, produz prova.
 *
 * É o que falta hoje no pipeline. As 7 camadas já registram **o que** foi
 * rejeitado (`reason`) e **onde** (`layer`), e nada registra **contra o quê**.
 * Um `code_incompatible` na tela diz ao contador que a combinação está errada e
 * não diz qual norma a torna errada — que é justamente o que ele precisa para
 * responder ao cliente, ou ao Fisco.
 *
 * ## Duas famílias, e por que as duas são critério
 *
 * A doutrina admite como parâmetro tanto norma pública quanto "contratos" e
 * "práticas habituais de grupos específicos". Então:
 *
 * - **Normativa** — lei, LC, IN, portaria, súmula, nota técnica. Tem vigência,
 *   muda sem nos avisar, e precisa ser conferida em texto oficial.
 * - **Interna** — invariante do produto (INV-001, INV-005, INV-006), decisão de
 *   arquitetura registrada em ADR, contrato da API. Não tem vigência porque
 *   vale enquanto o código vale, e é conferível lendo este repositório.
 *
 * A distinção importa porque só a primeira pode estar errada sem que ninguém
 * perceba. Um critério normativo não conferido produz achado que **existe e não
 * afirma** — ver `canAssert`.
 */

/** Espécie da fonte. Determina se há vigência a conferir. */
export const CRITERION_KINDS = [
  // --------------------------------------------------------------- normativa
  'constituicao',
  'lei_complementar',
  'lei_ordinaria',
  'medida_provisoria',
  'decreto',
  'instrucao_normativa',
  'portaria',
  'resolucao',
  'convenio_ou_ajuste',
  'nota_tecnica',
  'sumula',
  'precedente',
  'norma_contabil',
  // ------------------------------------------------------------------ interna
  /** INV-001, INV-005, INV-006 — as invariantes que o kernel garante. */
  'invariante_do_produto',
  /** Decisão registrada em `docs/adr/`. */
  'decisao_de_arquitetura',
  /** Forma que a API exige na entrada. Não é juízo fiscal. */
  'contrato_de_api',
] as const;

export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** Espécies internas: conferíveis lendo este repositório, e sem vigência. */
const KINDS_INTERNOS: readonly CriterionKind[] = [
  'invariante_do_produto',
  'decisao_de_arquitetura',
  'contrato_de_api',
];

export function isInternal(kind: CriterionKind): boolean {
  return KINDS_INTERNOS.includes(kind);
}

export interface EvaluationCriterion {
  /** Estável e citável em relatório. `inv-001`, `ctn-150-4`, `it-rt-2025-002`. */
  criterionId: string;
  kind: CriterionKind;
  /**
   * A citação como vai impressa: `CTN, art. 150, §4º`, `INV-001`,
   * `LC 214/2025, art. 156-A`. Nunca vazia.
   */
  citation: string;
  /**
   * O parâmetro em uma frase verificável — o que se esperava encontrar. É esta
   * frase, e não o `reason`, que explica ao contador por que o documento não
   * passou.
   */
  parameter: string;
  /** `null` em critério interno: ele vale enquanto o código vale. */
  validFrom: string | null;
  validTo: string | null;
  /**
   * Identificação do texto conferido: URL do Planalto, número do DOU, caminho
   * do ADR. `null` obriga `verified: false`.
   */
  sourceRef: string | null;
  /**
   * `false` = a citação foi digitada e **não** foi conferida em texto oficial.
   * O critério continua sendo usado e exibido; o que ele não faz é sustentar
   * uma afirmação. Ver `canAssert`.
   */
  verified: boolean;
}

/** Vigente na data? Critério interno é sempre vigente. */
export function isEffective(criterion: EvaluationCriterion, onDate: string): boolean {
  if (isInternal(criterion.kind)) {
    return true;
  }
  if (criterion.validFrom !== null && onDate < criterion.validFrom) {
    return false;
  }
  return criterion.validTo === null || onDate <= criterion.validTo;
}

/**
 * Pode sustentar uma afirmação?
 *
 * Exige critério presente, vigente na data e conferido. É a guarda que impede o
 * produto de dizer "este crédito é indevido conforme o art. X" quando ninguém
 * abriu o art. X — e é a mesma regra que `code-validation.ts` já aplica às
 * tabelas oficiais não carregadas: ausência de conferência nunca aparece como
 * conferência.
 */
export function canAssert(criterion: EvaluationCriterion | null, onDate: string): boolean {
  return criterion !== null && criterion.verified && isEffective(criterion, onDate);
}

/**
 * Forma reduzida que viaja no payload do evento e no relatório.
 *
 * Só o que identifica e cita. O `parameter` inteiro fica no catálogo, porque
 * repeti-lo em cada um dos milhares de `output.rejected` de um lote inflaria o
 * log com texto que não muda.
 */
export interface CriterionRef {
  criterion_id: string;
  kind: CriterionKind;
  citation: string;
  verified: boolean;
}

export function toRef(criterion: EvaluationCriterion): CriterionRef {
  return {
    criterion_id: criterion.criterionId,
    kind: criterion.kind,
    citation: criterion.citation,
    verified: criterion.verified,
  };
}
