import { censo, type AuditProcedure } from './audit-procedure.js';

/**
 * As trilhas que o módulo nasce sabendo executar.
 *
 * Todas em **censo**: o sistema tem os XMLs inteiros, e amostrar seria
 * descartar dado que já está no banco. Cada uma declara o critério que a
 * fundamenta; enquanto esse critério não estiver conferido em texto oficial, a
 * execução sai `inconclusive` e os achados aparecem sem afirmar.
 *
 * `active: false` nas que dependem de dado que a ingestão ainda não coleta.
 * Declarar a trilha e desligá-la é melhor do que omiti-la: o escritório vê o
 * que ainda não é conferido, em vez de supor que é.
 */
export const TRILHAS_INICIAIS: readonly AuditProcedure[] = [
  {
    procedureId: 'credito-sem-documento-habil',
    name: 'Crédito sem documento hábil',
    description:
      'Crédito apropriado sobre documento que não passa no teste de comprovação: ' +
      'chave que não fecha, emitente divergente ou CNPJ que não é parte da operação.',
    population: 'creditos_de_entrada',
    sampling: censo(),
    verifications: ['v1_fidedignidade_e_atores'],
    criterionId: 'lc-214-credito-documento-habil',
    appliesToRegimes: null,
    reversalPolicy: 'propor_estorno',
    active: true,
  },
  {
    procedureId: 'classificacao-incompativel',
    name: 'CST, cClassTrib e NCM incompatíveis',
    description:
      'Combinação que a SEFAZ autoriza na emissão e a apuração pune. Delega a ' +
      'conferência ao catálogo, para não haver duas respostas para a mesma pergunta.',
    population: 'itens_do_catalogo',
    sampling: censo(),
    verifications: ['v3_lancamento_correto'],
    criterionId: 'it-rt-2025-002',
    appliesToRegimes: null,
    reversalPolicy: 'somente_achado',
    active: true,
  },
  {
    procedureId: 'credito-extemporaneo',
    name: 'Crédito extemporâneo',
    description:
      'Documento apropriado em competência diferente da emissão — o erro que só ' +
      'aparece quando alguém cruza as duas datas.',
    population: 'creditos_de_entrada',
    sampling: censo(),
    verifications: ['v2_data_documento_x_lancamento'],
    criterionId: 'lc-214-competencia-do-credito',
    appliesToRegimes: null,
    reversalPolicy: 'propor_estorno',
    active: true,
  },
  {
    procedureId: 'credito-sobre-documento-cancelado',
    name: 'Crédito sobre documento cancelado ou denegado',
    description:
      'O cancelamento é trazido pela distribuição da SEFAZ, então esta trilha ' +
      'reprova de fato. A denegação continua não coletada, e por isso a ' +
      'verificação só afirma o que a fonte sustenta.',
    population: 'creditos_de_entrada',
    sampling: censo(),
    verifications: ['v4_autorizacao_competente'],
    criterionId: 'lc-214-credito-documento-habil',
    appliesToRegimes: null,
    reversalPolicy: 'propor_estorno',
    active: true,
  },
  {
    procedureId: 'uso-e-consumo-com-credito',
    name: 'Uso e consumo com crédito apropriado',
    description:
      'Audita a declaração de destinação do contador contra o crédito tomado. ' +
      'Desligada enquanto o cadastro não tiver o campo: não existe tabela oficial ' +
      'que derive insumo × uso e consumo do NCM, porque a lei define pela atividade.',
    population: 'creditos_de_entrada',
    sampling: censo(),
    verifications: ['v5_relacao_com_a_atividade'],
    criterionId: 'lc-214-uso-e-consumo',
    appliesToRegimes: null,
    reversalPolicy: 'propor_estorno',
    active: false,
  },
  {
    procedureId: 'teste-completo-do-credito',
    name: 'Teste de comprovação completo sobre o crédito',
    description:
      'As cinco verificações sobre cada crédito de entrada. É a trilha que produz ' +
      'evidência de confiabilidade, e não só a ausência de defeito conhecido.',
    population: 'creditos_de_entrada',
    sampling: censo(),
    verifications: [
      'v1_fidedignidade_e_atores',
      'v2_data_documento_x_lancamento',
      'v3_lancamento_correto',
      'v4_autorizacao_competente',
      'v5_relacao_com_a_atividade',
    ],
    criterionId: 'lc-214-credito-documento-habil',
    appliesToRegimes: null,
    reversalPolicy: 'propor_estorno',
    active: true,
  },
];
