import { isValidAccessKey, parseAccessKey } from '../ingestion/access-key.js';
import { validateClassification, type CodeTables } from '../catalog/code-validation.js';
import { toRef, type EvaluationCriterion } from '../shared/evaluation-criterion.js';
import type { ExaminableSubject } from './audit-procedure.js';
import type { ComparedField, Verification, VerificationResult } from './verifications.js';

/**
 * Os verificadores: uma função por verificação, pura.
 *
 * **Quatro das cinco rodam hoje, e a quinta não.** Isso é estado declarado, não
 * lacuna escondida: um verificador ausente devolve `not_verified`, que o
 * `conclude` trata como teste que não concluiu e que bloqueia estorno. A
 * alternativa — deixar de registrar a verificação — a faria desaparecer do
 * relatório, e o contador leria "conferido" onde nada foi comparado.
 */

export interface VerifierContext {
  /** CNPJ sob exame. Define quem deveria ser emitente ou destinatário. */
  cnpj: string;
  criterion: EvaluationCriterion;
  /** Tabelas oficiais. Vazias fazem a verificação 3 sair `not_verified`. */
  tables: CodeTables;
  tablesLoaded: boolean;
}

export type Verifier = (
  subject: ExaminableSubject,
  context: VerifierContext,
) => VerificationResult;

function resultado(
  verification: Verification,
  outcome: VerificationResult['outcome'],
  rationale: string,
  compared: ComparedField[],
  criterion: EvaluationCriterion,
): VerificationResult {
  return { verification, outcome, rationale, compared, criterion: toRef(criterion) };
}

function campo(
  field: string,
  documentValue: string | null,
  criterionValue: string | null,
  matches: boolean,
): ComparedField {
  return { field, documentValue: documentValue ?? '(ausente)', criterionValue, matches };
}

// ------------------------------------------------------------------------ V1

/**
 * Fidedignidade e atores: a chave de acesso fecha, e o CNPJ examinado é mesmo
 * parte da operação.
 *
 * O dígito verificador da chave é o que pega documento montado à mão. Os atores
 * pegam o caso em que um documento de terceiro entrou na pasta errada — que
 * gera crédito em CNPJ que não participou da operação.
 */
export const verificarFidedignidade: Verifier = (subject, ctx) => {
  const v: Verification = 'v1_fidedignidade_e_atores';

  if (subject.accessKey === null) {
    return resultado(v, 'not_verified', 'O sujeito não tem chave de acesso a conferir.', [], ctx.criterion);
  }

  const comparacoes: ComparedField[] = [];
  const chaveValida = isValidAccessKey(subject.accessKey);
  comparacoes.push(campo('chave_de_acesso', subject.accessKey, 'dígito verificador confere', chaveValida));

  if (!chaveValida) {
    return resultado(v, 'fail', 'A chave de acesso não fecha com o dígito verificador.', comparacoes, ctx.criterion);
  }

  const partes = parseAccessKey(subject.accessKey);
  const emitenteNaChave = partes.issuerCnpj === subject.issuerCnpj;
  comparacoes.push(
    campo('emitente', subject.issuerCnpj, partes.issuerCnpj, emitenteNaChave),
  );

  if (subject.issuerCnpj !== null && !emitenteNaChave) {
    return resultado(
      v,
      'fail',
      'O emitente declarado no documento não é o que está na chave de acesso.',
      comparacoes,
      ctx.criterion,
    );
  }

  const ehParte = subject.issuerCnpj === ctx.cnpj || subject.recipientCnpj === ctx.cnpj;
  comparacoes.push(campo('cnpj_examinado', ctx.cnpj, 'emitente ou destinatário', ehParte));

  if (!ehParte) {
    return resultado(
      v,
      'fail',
      `O CNPJ ${ctx.cnpj} não é emitente nem destinatário deste documento.`,
      comparacoes,
      ctx.criterion,
    );
  }

  return resultado(v, 'pass', 'Chave íntegra e o CNPJ examinado é parte da operação.', comparacoes, ctx.criterion);
};

// ------------------------------------------------------------------------ V2

/**
 * Data do documento contra a data do lançamento — o crédito extemporâneo.
 *
 * Apropriar em competência posterior à emissão é o erro que passa despercebido
 * até a apuração assistida cruzar as duas datas.
 */
export const verificarDataDoLancamento: Verifier = (subject, ctx) => {
  const v: Verification = 'v2_data_documento_x_lancamento';

  if (subject.documentPeriod === null || subject.appropriatedPeriod === null) {
    return resultado(
      v,
      'not_verified',
      'Falta a competência de emissão ou a de apropriação para comparar.',
      [],
      ctx.criterion,
    );
  }

  const igual = subject.documentPeriod === subject.appropriatedPeriod;
  const comparacoes = [
    campo('competencia_apropriada', subject.appropriatedPeriod, subject.documentPeriod, igual),
  ];

  if (igual) {
    return resultado(v, 'pass', 'Apropriado na competência da emissão.', comparacoes, ctx.criterion);
  }

  return resultado(
    v,
    'fail',
    `Documento emitido em ${subject.documentPeriod} e apropriado em ` +
      `${subject.appropriatedPeriod}: crédito extemporâneo.`,
    comparacoes,
    ctx.criterion,
  );
};

// ------------------------------------------------------------------------ V3

/**
 * Correção do lançamento: delega a `catalog/code-validation.ts`.
 *
 * Reimplementar a compatibilidade entre CFOP, CST, cClassTrib e NCM criaria
 * duas respostas possíveis para a mesma pergunta, e elas divergiriam na
 * primeira mudança de tabela.
 */
export const verificarLancamento: Verifier = (subject, ctx) => {
  const v: Verification = 'v3_lancamento_correto';

  if (subject.classification === null) {
    return resultado(v, 'not_verified', 'O sujeito não tem classificação a conferir.', [], ctx.criterion);
  }

  if (!ctx.tablesLoaded) {
    return resultado(
      v,
      'not_verified',
      'As tabelas oficiais de código não estão carregadas: nada foi comparado.',
      [],
      ctx.criterion,
    );
  }

  const outcome = validateClassification(subject.classification, ctx.tables);
  // `CodeIssue.field` nomeia uma chave da classificação, e o índice devolve o
  // valor que de fato estava lá — é ele que o contador precisa ver ao lado do
  // motivo, em vez de só o nome do campo.
  const classificacao = subject.classification as unknown as Record<string, string | undefined>;
  const comparacoes = outcome.issues.map((issue) =>
    campo(issue.field, classificacao[issue.field] ?? null, issue.suggestedFix ?? null, false),
  );

  if (outcome.health === 'error') {
    return resultado(
      v,
      'fail',
      outcome.issues.map((i) => i.message).join(' '),
      comparacoes,
      ctx.criterion,
    );
  }

  return resultado(
    v,
    'pass',
    outcome.health === 'warning'
      ? 'Classificação aceita, com ressalvas que não invalidam o lançamento.'
      : 'Classificação coerente com as tabelas oficiais.',
    comparacoes,
    ctx.criterion,
  );
};

// ------------------------------------------------------------------------ V4

/**
 * Autorização competente.
 *
 * Parcial por honestidade: o protocolo da SEFAZ é conferível, e o cancelamento
 * posterior **não é**, porque a ingestão ainda não coleta o evento de
 * cancelamento. Enquanto `cancelled` vier `null`, a verificação sai
 * `not_verified` mesmo com protocolo presente — dizer `pass` afirmaria que o
 * documento não foi cancelado, que é justamente o que não se sabe.
 */
export const verificarAutorizacao: Verifier = (subject, ctx) => {
  const v: Verification = 'v4_autorizacao_competente';
  const comparacoes: ComparedField[] = [];

  if (subject.cancelled === true || subject.denied === true) {
    comparacoes.push(
      campo('situacao', subject.cancelled === true ? 'cancelado' : 'denegado', 'autorizado', false),
    );
    return resultado(
      v,
      'fail',
      'O documento foi cancelado ou denegado, e não sustenta crédito.',
      comparacoes,
      ctx.criterion,
    );
  }

  if (subject.authorizationProtocol === null) {
    return resultado(
      v,
      'not_verified',
      'O protocolo de autorização da SEFAZ não foi coletado para este documento.',
      [],
      ctx.criterion,
    );
  }

  comparacoes.push(campo('protocolo', subject.authorizationProtocol, 'presente', true));

  if (subject.cancelled === null || subject.denied === null) {
    return resultado(
      v,
      'not_verified',
      'Protocolo presente, mas a situação atual na SEFAZ não foi consultada: ' +
        'um documento autorizado pode ter sido cancelado depois.',
      comparacoes,
      ctx.criterion,
    );
  }

  return resultado(v, 'pass', 'Autorizado pela SEFAZ e sem cancelamento posterior.', comparacoes, ctx.criterion);
};

// ------------------------------------------------------------------------ V5

/**
 * Relação com a atividade — insumo gera crédito, uso e consumo não.
 *
 * Sempre `not_verified` enquanto o cadastro não tiver a declaração de
 * destinação. **Não há tabela oficial que derive isso do NCM**: a LC 214 define
 * pela atividade do contribuinte, não pela mercadoria. Deduzir por CNAE
 * produziria glosa inventada no item mais caro da nota.
 */
export const verificarRelacaoComAtividade: Verifier = (subject, ctx) => {
  const v: Verification = 'v5_relacao_com_a_atividade';

  if (subject.usageKind === null) {
    return resultado(
      v,
      'not_verified',
      'A destinação do item não foi declarada, e não há tabela oficial que a ' +
        'derive do NCM: a lei define pela atividade, não pela mercadoria.',
      [],
      ctx.criterion,
    );
  }

  const tomouCredito = subject.creditState !== null && subject.creditState !== 'lost';
  const comparacoes = [
    campo('destinacao', subject.usageKind, 'insumo, para gerar crédito', subject.usageKind === 'insumo'),
  ];

  if (subject.usageKind === 'uso_e_consumo' && tomouCredito) {
    return resultado(
      v,
      'fail',
      'Item declarado como uso e consumo com crédito apropriado.',
      comparacoes,
      ctx.criterion,
    );
  }

  return resultado(v, 'pass', 'A destinação declarada é compatível com o crédito tomado.', comparacoes, ctx.criterion);
};

/** Registro por verificação. Ausente devolve `not_verified` no executor. */
export const VERIFIERS: Partial<Record<Verification, Verifier>> = {
  v1_fidedignidade_e_atores: verificarFidedignidade,
  v2_data_documento_x_lancamento: verificarDataDoLancamento,
  v3_lancamento_correto: verificarLancamento,
  v4_autorizacao_competente: verificarAutorizacao,
  v5_relacao_com_a_atividade: verificarRelacaoComAtividade,
};
