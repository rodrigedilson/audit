/**
 * Validação da classificação de um item contra as tabelas oficiais.
 *
 * É a camada 3 do pipeline no que diz respeito a códigos fiscais, e o núcleo do
 * diferencial #1: o erro nasce aqui, no cadastro, e contamina toda nota emitida
 * com o item. Um verificador que olha um XML por vez nunca chega a esta
 * pergunta.
 *
 * Função pura, sem I/O: recebe as tabelas já carregadas. Isso mantém testável a
 * parte que decide, e deixa o carregamento como detalhe do adapter.
 */

export type IssueReason =
  /** Fora do formato: quantidade de dígitos, caractere não numérico. */
  | 'schema_violation'
  /** Formato certo, código não existe na tabela oficial. */
  | 'unknown_code'
  /** Códigos existem, mas a combinação é inválida. */
  | 'code_incompatible'
  /** Falta classificação exigida pela reforma. */
  | 'missing_reform_classification'
  /**
   * Não deu para verificar porque a tabela de referência não foi carregada.
   * Existe para que ausência de dado nunca apareça como aprovação — validar
   * contra tabela vazia aprovaria qualquer código, o que é pior do que não
   * validar.
   */
  | 'not_verified';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Health = 'ok' | 'warning' | 'error';

export interface CodeIssue {
  reason: IssueReason;
  severity: Severity;
  /** Campo da classificação a que a inconsistência se refere. */
  field: string;
  message: string;
  suggestedFix?: string;
}

export interface Classification {
  effectiveFrom: string;
  ncm?: string;
  nbs?: string;
  cstIbsCbs?: string;
  cclasstrib?: string;
  cstIcms?: string;
  cstPisCofins?: string;
  cfopDefault?: string;
  justification?: string;
}

export interface NcmFlags {
  monophasic: boolean;
  taxSubstitution: boolean;
}

export interface CodeTables {
  ncm: ReadonlySet<string>;
  nbs: ReadonlySet<string>;
  cfop: ReadonlySet<string>;
  cstIcms: ReadonlySet<string>;
  cstPisCofins: ReadonlySet<string>;
  cstIbsCbs: ReadonlySet<string>;
  /** cClassTrib -> CSTs de IBS/CBS com que ele é compatível. */
  cclasstribCst: ReadonlyMap<string, ReadonlySet<string>>;
  ncmFlags: ReadonlyMap<string, NcmFlags>;
}

export interface ValidationOutcome {
  health: Health;
  issues: CodeIssue[];
  /** Marcações do NCM, quando conhecidas. Informativo, não inconsistência. */
  flags?: NcmFlags;
}

export function emptyCodeTables(): CodeTables {
  return {
    ncm: new Set(),
    nbs: new Set(),
    cfop: new Set(),
    cstIcms: new Set(),
    cstPisCofins: new Set(),
    cstIbsCbs: new Set(),
    cclasstribCst: new Map(),
    ncmFlags: new Map(),
  };
}

/**
 * Indexados pelo nome do campo em `Classification`, não pelo nome do código.
 * A distinção importa: o campo do CFOP é `cfopDefault`, e indexar por `cfop`
 * fazia a checagem de formato do CFOP nunca rodar.
 */
const FORMATOS: Partial<Record<keyof Classification, { padrao: RegExp; descricao: string }>> = {
  ncm: { padrao: /^[0-9]{8}$/, descricao: '8 dígitos' },
  cfopDefault: { padrao: /^[0-9]{4}$/, descricao: '4 dígitos' },
  cclasstrib: { padrao: /^[0-9]{6}$/, descricao: '6 dígitos' },
  cstIbsCbs: { padrao: /^[0-9]{3}$/, descricao: '3 dígitos' },
  cstIcms: { padrao: /^[0-9]{2,3}$/, descricao: '2 ou 3 dígitos (CST ou CSOSN)' },
  cstPisCofins: { padrao: /^[0-9]{2}$/, descricao: '2 dígitos' },
};

const ROTULOS: Partial<Record<keyof Classification, string>> = {
  ncm: 'NCM',
  nbs: 'NBS',
  cfopDefault: 'CFOP',
  cclasstrib: 'cClassTrib',
  cstIbsCbs: 'CST-IBS/CBS',
  cstIcms: 'CST-ICMS',
  cstPisCofins: 'CST-PIS/Cofins',
};

export function validateClassification(
  classification: Classification,
  tables: CodeTables,
): ValidationOutcome {
  const issues: CodeIssue[] = [];

  verificarFormato(classification, issues);
  verificarExistencia(classification, tables, issues);
  verificarCompatibilidade(classification, tables, issues);
  verificarProntidaoReforma(classification, issues);

  const flags =
    classification.ncm !== undefined ? tables.ncmFlags.get(classification.ncm) : undefined;

  return {
    health: derivarSaude(issues),
    issues,
    ...(flags === undefined ? {} : { flags }),
  };
}

/**
 * `error` a partir de `high`: um código inexistente ou combinação inválida faz a
 * nota ser rejeitada na apuração, mesmo que a SEFAZ autorize a emissão. É o erro
 * de mérito que o produto existe para pegar.
 */
export function derivarSaude(issues: readonly CodeIssue[]): Health {
  if (issues.some((i) => i.severity === 'critical' || i.severity === 'high')) {
    return 'error';
  }
  return issues.length > 0 ? 'warning' : 'ok';
}

function verificarFormato(classification: Classification, issues: CodeIssue[]): void {
  for (const [campo, formato] of Object.entries(FORMATOS)) {
    const chave = campo as keyof Classification;
    const valor = classification[chave];
    if (typeof valor !== 'string' || valor.length === 0) {
      continue;
    }
    if (!formato!.padrao.test(valor)) {
      issues.push({
        reason: 'schema_violation',
        severity: 'critical',
        field: campo,
        message:
          `${ROTULOS[chave]} '${valor}' fora do formato: esperado ${formato!.descricao}.`,
        suggestedFix: `Corrija o ${ROTULOS[chave]} no cadastro do item.`,
      });
    }
  }
}

function verificarExistencia(
  classification: Classification,
  tables: CodeTables,
  issues: CodeIssue[],
): void {
  const checagens: [keyof Classification, ReadonlySet<string>][] = [
    ['ncm', tables.ncm],
    ['nbs', tables.nbs],
    ['cfopDefault', tables.cfop],
    ['cstIcms', tables.cstIcms],
    ['cstPisCofins', tables.cstPisCofins],
    ['cstIbsCbs', tables.cstIbsCbs],
  ];

  for (const [campo, tabela] of checagens) {
    const valor = classification[campo];
    if (typeof valor !== 'string' || valor.length === 0) {
      continue;
    }

    // Formato inválido já foi reportado; cobrar existência em cima disso só
    // duplicaria a mensagem.
    const formato = FORMATOS[campo];
    if (formato && !formato.padrao.test(valor)) {
      continue;
    }

    const rotulo = ROTULOS[campo];

    if (tabela.size === 0) {
      issues.push({
        reason: 'not_verified',
        severity: 'low',
        field: campo,
        message: `${rotulo} '${valor}' não verificado: tabela de referência não carregada.`,
        suggestedFix: `Carregue a tabela oficial de ${rotulo} em fiscal_codes.`,
      });
      continue;
    }

    if (!tabela.has(valor)) {
      issues.push({
        reason: 'unknown_code',
        severity: 'high',
        field: campo,
        message: `${rotulo} '${valor}' não existe na tabela oficial vigente.`,
        suggestedFix: `Confira o ${rotulo} do item na tabela oficial.`,
      });
    }
  }
}

/**
 * cClassTrib × CST-IBS/CBS.
 *
 * É a combinação que a SEFAZ autoriza e a apuração pune: os dois códigos existem
 * isoladamente, e o par é inválido. Por isso `critical`.
 */
function verificarCompatibilidade(
  classification: Classification,
  tables: CodeTables,
  issues: CodeIssue[],
): void {
  const { cclasstrib, cstIbsCbs } = classification;
  if (!cclasstrib || !cstIbsCbs) {
    return;
  }
  if (!FORMATOS.cclasstrib!.padrao.test(cclasstrib)) {
    return;
  }
  if (!FORMATOS.cstIbsCbs!.padrao.test(cstIbsCbs)) {
    return;
  }

  if (tables.cclasstribCst.size === 0) {
    issues.push({
      reason: 'not_verified',
      severity: 'low',
      field: 'cclasstrib',
      message:
        `Compatibilidade entre cClassTrib '${cclasstrib}' e CST-IBS/CBS '${cstIbsCbs}' ` +
        'não verificada: tabela de pareamento não carregada.',
      suggestedFix: 'Carregue a tabela oficial de cClassTrib em cclasstrib_cst.',
    });
    return;
  }

  const compativeis = tables.cclasstribCst.get(cclasstrib);

  if (compativeis === undefined) {
    issues.push({
      reason: 'unknown_code',
      severity: 'high',
      field: 'cclasstrib',
      message: `cClassTrib '${cclasstrib}' não existe na tabela oficial.`,
      suggestedFix: 'Confira o cClassTrib na IT RT 2025.002.',
    });
    return;
  }

  if (!compativeis.has(cstIbsCbs)) {
    const esperados = [...compativeis].sort().join(', ');
    issues.push({
      reason: 'code_incompatible',
      severity: 'critical',
      field: 'cclasstrib',
      message:
        `cClassTrib '${cclasstrib}' é incompatível com CST-IBS/CBS '${cstIbsCbs}'. ` +
        `Esse cClassTrib vale para: ${esperados}.`,
      suggestedFix:
        `Use um CST-IBS/CBS entre ${esperados}, ou troque o cClassTrib para um ` +
        `compatível com '${cstIbsCbs}'.`,
    });
  }
}

/**
 * Item sem classificação de IBS/CBS. Não é erro hoje — é o indicador de
 * prontidão da carteira para a reforma, e o trabalho que o escritório tem à
 * frente.
 */
function verificarProntidaoReforma(classification: Classification, issues: CodeIssue[]): void {
  const faltando: string[] = [];
  if (!classification.cstIbsCbs) faltando.push('CST-IBS/CBS');
  if (!classification.cclasstrib) faltando.push('cClassTrib');

  if (faltando.length > 0) {
    issues.push({
      reason: 'missing_reform_classification',
      severity: 'medium',
      field: 'cstIbsCbs',
      message: `Item sem ${faltando.join(' e ')}: não está pronto para a apuração de IBS/CBS.`,
      suggestedFix: 'Classifique o item para o novo sistema antes da competência de 2027-01.',
    });
  }
}
