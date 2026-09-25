import type { EvaluationCriterion } from './evaluation-criterion.js';

/**
 * Catálogo dos critérios internos: o parâmetro que cada camada do pipeline de
 * fato aplica.
 *
 * Ficam em código, e não em tabela, porque é código que os torna verdadeiros. A
 * camada 6 não rejeita escrita em competência confirmada porque uma linha de
 * banco manda — rejeita porque `ClosedPeriodGuardService` existe. Guardá-los
 * fora do repositório abriria a possibilidade de o catálogo discordar do
 * comportamento, e um critério que descreve errado o que o sistema faz é pior
 * do que nenhum.
 *
 * Todos nascem `verified: true` por um motivo que não vale para critério
 * normativo: a conferência aqui é ler o arquivo citado em `sourceRef`, que está
 * neste mesmo repositório e é versionado junto.
 */

function interno(
  criterionId: string,
  kind: EvaluationCriterion['kind'],
  citation: string,
  parameter: string,
  sourceRef: string,
): EvaluationCriterion {
  return {
    criterionId,
    kind,
    citation,
    parameter,
    validFrom: null,
    validTo: null,
    sourceRef,
    verified: true,
  };
}

export const CRITERIOS_INTERNOS = {
  // ------------------------------------------------- camadas 1 e 2: a entrada
  /**
   * Camadas 1 e 2 não fazem juízo fiscal: conferem que a intenção tem a forma
   * que a API exige. Chamá-las de normativas produziria citação de lei onde o
   * que falhou foi um campo ausente.
   */
  'contrato-intencao': interno(
    'contrato-intencao',
    'contrato_de_api',
    'Contrato da intenção fiscal',
    'A intenção traz `action`, `task_id`, `actor` como texto não vazio e ' +
      '`payload` como objeto.',
    'src/fiscal/shared/fiscal-projection.types.ts',
  ),

  // ------------------------------------------- camada 3: vocabulário fechado
  'vocabulario-fechado': interno(
    'vocabulario-fechado',
    'decisao_de_arquitetura',
    'Vocabulário controlado fiscal',
    'A ação pertence ao vocabulário fechado; ação fora dele não escreve no log.',
    'src/fiscal/shared/fiscal-vocabulary.ts',
  ),

  /**
   * A separação entre propor e efetivar é o argumento de governança que se
   * vende ao escritório: nenhuma IA altera um número fiscal sozinha.
   */
  'proposta-e-efetivacao': interno(
    'proposta-e-efetivacao',
    'decisao_de_arquitetura',
    'Separação entre proposta e efetivação',
    'Agente propõe e não efetiva; quem registra o ato final é o orquestrador, ' +
      'a partir de um usuário identificado.',
    'docs/agents/README.md',
  ),

  // --------------------------------------- camada 4: máquina de estados
  'ciclo-da-competencia': interno(
    'ciclo-da-competencia',
    'invariante_do_produto',
    'INV-001 — ciclo da competência',
    'A competência percorre open → assessed → reconciled → confirmed, e só ' +
      'transições declaradas são aceitas.',
    'src/fiscal/period/period-transition.service.ts',
  ),

  // ------------------------------------------------ camada 5: fronteiras
  'fronteira-do-agente': interno(
    'fronteira-do-agente',
    'decisao_de_arquitetura',
    'Contrato de fronteira do agente',
    'O agente só escreve nos caminhos que o contrato lhe abre; `forbidden` ' +
      'tem precedência sobre `writable`.',
    'config/AGENT_CONTRACT.yaml',
  ),

  // -------------------------------------------- camada 6: imutabilidade
  'competencia-confirmada-e-terminal': interno(
    'competencia-confirmada-e-terminal',
    'invariante_do_produto',
    'INV-001 — competência confirmada é terminal',
    'Competência confirmada não aceita alteração; a correção abre competência ' +
      'de retificação vinculada e preserva o hash original.',
    'src/fiscal/period/period-transition.service.ts',
  ),

  // ----------------------------------------- camada 7: portão de verificação
  'projecao-fecha-com-o-log': interno(
    'projecao-fecha-com-o-log',
    'invariante_do_produto',
    'INV-006 — replay determinístico',
    'A projeção reproduzida do log confere com o hash gravado; é o que torna o ' +
      'número defensável contra a apuração do Fisco.',
    'docs/adr/ADR-005-canonicalizacao-do-hash.md',
  ),

  // ---------------------------------------------------------- transversais
  'isolamento-por-escritorio': interno(
    'isolamento-por-escritorio',
    'decisao_de_arquitetura',
    'ADR-002 — isolamento por escritório e CNPJ',
    'Toda leitura e escrita é escopada a um par (escritório, CNPJ) da carteira ' +
      'de quem pede.',
    'docs/adr/ADR-002-multi-tenancy-e-isolamento.md',
  ),

  'escritor-unico-por-cnpj': interno(
    'escritor-unico-por-cnpj',
    'invariante_do_produto',
    'INV-005 — escritor único por CNPJ',
    'Uma escrita por vez em cada CNPJ, para que duas apurações concorrentes ' +
      'não produzam sequência com buraco.',
    'docs/adr/ADR-003-event-store-postgres.md',
  ),
} as const satisfies Record<string, EvaluationCriterion>;

export type CriterioInternoId = keyof typeof CRITERIOS_INTERNOS;

export function criterioInterno(id: CriterioInternoId): EvaluationCriterion {
  return CRITERIOS_INTERNOS[id];
}
