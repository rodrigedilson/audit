/**
 * Conciliação da EFD ICMS/IPI contra ela mesma.
 *
 * O arquivo declara a apuração no `E110` e no `E520`, e declara os documentos
 * que a sustentam nos blocos C. Nada garante que os dois concordem: o PVA aceita
 * arquivo com apuração que não fecha com os documentos, e quem recebe a conta é
 * o contribuinte, meses depois.
 *
 * Estas conferências refazem a aritmética que o próprio guia manda o arquivo
 * obedecer, e somam os documentos para ver se batem com o declarado. Não é
 * opinião nossa sobre quanto deveria ser: é a escrituração conferida contra as
 * regras dela.
 *
 * **As regras vieram do Guia Prático EFD-ICMS/IPI 3.2.2**, das validações dos
 * campos 11, 13 e 14 do `E110` e 7 e 8 do `E520`, e não de dedução. Uma delas
 * não é intuitiva: quando a apuração dá saldo credor, o valor que vai para
 * `VL_SLD_CREDOR_TRANSPORTAR` inclui as deduções.
 *
 * **Conferência que não pôde rodar vira `not_verified`, nunca `passed`.** É a
 * regra da casa e aqui ela morde de verdade: um arquivo sem `E110` não é um
 * arquivo com apuração correta, e uma empresa que tem conta de energia lança
 * ICMS por registros que estas somas não cobrem — dizer "confere" nesses casos
 * seria inventar uma garantia.
 */
import type {
  EfdIcmsAssessment,
  EfdIpiAssessment,
} from '../ingestion/efd-icms-ipi.parser.js';
import type { IcmsIpiDocumentSummary, IcmsIpiInput } from './icms-ipi-summary.js';
import type { Severity } from '../reporting/audit-trails.js';

export { summarizeEfdIcmsIpi, type IcmsIpiDocumentSummary, type IcmsIpiInput } from './icms-ipi-summary.js';

export type CheckStatus = 'passed' | 'failed' | 'not_verified';

export interface IcmsIpiIssue {
  /** Chave de acesso ou número do documento — o que a divergência aponta. */
  subject: string;
  message: string;
  differenceCents: number;
}

export interface IcmsIpiCheck {
  checkId: string;
  name: string;
  /** A regra conferida, com a origem. Vai para a tela e para o Book. */
  rule: string;
  status: CheckStatus;
  severity: Severity;
  /**
   * Por que não deu para conferir. `null` quando conferiu.
   *
   * Existe porque `not_verified` sem motivo é indistinguível de desleixo: quem
   * lê precisa saber se falta arquivo, falta registro ou falta suporte nosso.
   */
  notVerifiedReason: string | null;
  /** O que a escrituração declara. `null` quando não foi possível conferir. */
  declaredCents: number | null;
  /** O que a regra do guia produz a partir dos outros campos do arquivo. */
  expectedCents: number | null;
  differenceCents: number | null;
  issues: IcmsIpiIssue[];
}

export interface IcmsIpiReconciliation {
  period: string;
  checks: IcmsIpiCheck[];
  /** Soma das diferenças absolutas das conferências que falharam. */
  totalDifferenceCents: number;
  failedCount: number;
  notVerifiedCount: number;
}

/**
 * Situações em que o documento não produz imposto: cancelado (02), cancelado
 * extemporâneo (03), denegado (04) e numeração inutilizada (05). Subseção 1.3
 * do guia.
 */
const SITUACOES_SEM_IMPOSTO = new Set(['02', '03', '04', '05']);

/**
 * Documento extemporâneo (01) e complementar extemporâneo (07): o guia os tira
 * de `VL_TOT_DEBITOS` (vão para `DEB_ESP`), mas não de `VL_TOT_CREDITOS`, onde
 * entram no primeiro período do arquivo.
 */
const EXTEMPORANEOS = new Set(['01', '07']);

/**
 * Registros cujo `VL_ICMS` compõe o `E110`, da validação dos campos 02 e 06 no
 * Guia Prático 3.2.2. É a lista do guia, e não um prefixo de bloco: todo
 * arquivo tem `C001`, `C990`, `D001` e `D990`, que não lançam nada.
 *
 * Registro da lista que o arquivo traz e esta soma não cobre impede a
 * conferência daquele lado: faltaria parcela legítima, e a diferença apareceria
 * como erro do cliente quando é limitação nossa.
 */
const COMPOEM_DEBITOS = [
  'C190', 'C320', 'C390', 'C490', 'C590', 'C690', 'C790', 'C850', 'C890',
  'D190', 'D300', 'D390', 'D410', 'D590', 'D690', 'D696', 'D730', 'D760',
];
const COMPOEM_CREDITOS = ['C190', 'C590', 'D190', 'D590', 'D730'];

export function reconcileIcmsIpi(entrada: IcmsIpiInput): IcmsIpiReconciliation {
  const checks: IcmsIpiCheck[] = [
    conferirSaldoApurado(entrada.icmsAssessment),
    conferirIcmsARecolher(entrada.icmsAssessment),
    conferirSaldoCredorTransportar(entrada.icmsAssessment),
    conferirApuracaoIpi(entrada.ipiAssessment),
    conferirItensContraConsolidacao(entrada.documents),
    ...conferirConsolidacaoContraApuracao(entrada),
    conferirDocumentosSemImposto(entrada.documents),
  ];

  const falhas = checks.filter((c) => c.status === 'failed');

  return {
    period: entrada.period,
    checks,
    totalDifferenceCents: falhas.reduce((t, c) => t + Math.abs(c.differenceCents ?? 0), 0),
    failedCount: falhas.length,
    notVerifiedCount: checks.filter((c) => c.status === 'not_verified').length,
  };
}

// ------------------------------------------------------------- aritmética

/**
 * Expressão da apuração, como o guia a define na validação do campo 11 do
 * `E110`: débitos e estornos de crédito menos créditos, estornos de débito e
 * saldo credor anterior. As deduções ficam de fora — entram só no campo 14.
 */
function expressaoDaApuracao(e110: EfdIcmsAssessment): number {
  const devedor =
    e110.totalDebitsCents +
    e110.documentDebitAdjustmentsCents +
    e110.adjustmentDebitsCents +
    e110.creditReversalsCents;

  const credor =
    e110.totalCreditsCents +
    e110.documentCreditAdjustmentsCents +
    e110.adjustmentCreditsCents +
    e110.debitReversalsCents +
    e110.previousCreditBalanceCents;

  return devedor - credor;
}

function conferirSaldoApurado(e110: EfdIcmsAssessment | null): IcmsIpiCheck {
  const base = {
    checkId: 'e110-saldo-apurado',
    name: 'Saldo apurado do ICMS',
    rule:
      'VL_SLD_APURADO = (VL_TOT_DEBITOS + VL_AJ_DEBITOS + VL_TOT_AJ_DEBITOS + ' +
      'VL_ESTORNOS_CRED) − (VL_TOT_CREDITOS + VL_AJ_CREDITOS + VL_TOT_AJ_CREDITOS + ' +
      'VL_ESTORNOS_DEB + VL_SLD_CREDOR_ANT), zerado quando negativo. ' +
      'Guia Prático EFD-ICMS/IPI 3.2.2, validação do campo 11 do E110.',
    severity: 'high' as Severity,
  };

  if (e110 === null) {
    return semE110(base);
  }

  return comparar(base, e110.assessedBalanceCents, Math.max(expressaoDaApuracao(e110), 0));
}

function conferirIcmsARecolher(e110: EfdIcmsAssessment | null): IcmsIpiCheck {
  const base = {
    checkId: 'e110-icms-a-recolher',
    name: 'ICMS a recolher',
    rule:
      'VL_ICMS_RECOLHER = VL_SLD_APURADO − VL_TOT_DED, zerado quando negativo. ' +
      'Guia Prático EFD-ICMS/IPI 3.2.2, validação do campo 13 do E110.',
    severity: 'critical' as Severity,
  };

  if (e110 === null) {
    return semE110(base);
  }

  const esperado = Math.max(e110.assessedBalanceCents - e110.deductionsCents, 0);
  return comparar(base, e110.icmsPayableCents, esperado);
}

function conferirSaldoCredorTransportar(e110: EfdIcmsAssessment | null): IcmsIpiCheck {
  const base = {
    checkId: 'e110-saldo-credor-transportar',
    name: 'Saldo credor a transportar',
    rule:
      'VL_SLD_CREDOR_TRANSPORTAR = valor absoluto da expressão da apuração quando ' +
      'ela, já descontadas as deduções (VL_TOT_DED), for negativa; zero caso ' +
      'contrário. Guia Prático EFD-ICMS/IPI 3.2.2, validação do campo 14 do E110.',
    severity: 'critical' as Severity,
  };

  if (e110 === null) {
    return semE110(base);
  }

  const comDeducoes = expressaoDaApuracao(e110) - e110.deductionsCents;
  return comparar(base, e110.carriedCreditBalanceCents, Math.max(-comDeducoes, 0));
}

function conferirApuracaoIpi(e520: EfdIpiAssessment | null): IcmsIpiCheck {
  const base = {
    checkId: 'e520-apuracao-ipi',
    name: 'Apuração do IPI',
    rule:
      'VL_DEB_IPI + VL_OD_IPI − (VL_SD_ANT_IPI + VL_CRED_IPI + VL_OC_IPI): se ' +
      'positivo vai para VL_SD_IPI com VL_SC_IPI zerado; se negativo, o valor ' +
      'absoluto vai para VL_SC_IPI com VL_SD_IPI zerado. Guia Prático ' +
      'EFD-ICMS/IPI 3.2.2, validação dos campos 7 e 8 do E520.',
    severity: 'high' as Severity,
  };

  if (e520 === null) {
    return {
      ...base,
      status: 'not_verified',
      notVerifiedReason:
        'A escrituração não traz registro E520. Sem ele não há apuração de IPI ' +
        'declarada para conferir — o que não é o mesmo que IPI zerado.',
      declaredCents: null,
      expectedCents: null,
      differenceCents: null,
      issues: [],
    };
  }

  const expressao =
    e520.debitsCents +
    e520.otherDebitsCents -
    (e520.previousCreditBalanceCents + e520.creditsCents + e520.otherCreditsCents);

  // Declarado e esperado são comparados como saldo líquido: devedor positivo,
  // credor negativo. Assim uma troca entre os dois campos aparece como
  // divergência, em vez de dois acertos que se cancelam.
  const declarado = e520.ipiPayableCents - e520.carriedCreditBalanceCents;
  return comparar(base, declarado, expressao);
}

// ------------------------------------------------------- documentos × total

function conferirItensContraConsolidacao(
  documentos: readonly IcmsIpiDocumentSummary[],
): IcmsIpiCheck {
  const base = {
    checkId: 'c170-vs-c190',
    name: 'Itens contra a consolidação do documento',
    rule:
      'Para cada documento que traz itens (C170) e consolidação (C190), a soma do ' +
      'VL_ICMS dos itens deve igualar a soma do VL_ICMS da consolidação.',
    severity: 'medium' as Severity,
  };

  // NF-e de emissão própria costuma vir só com C100 e C190, sem C170 (Exceção 2
  // do guia). Documento sem item não é documento com erro, e entra como fora do
  // alcance da conferência, não como divergência.
  const comparaveis = documentos.filter((d) => d.hasItems && d.hasAnalytics);

  if (comparaveis.length === 0) {
    return {
      ...base,
      status: 'not_verified',
      notVerifiedReason:
        'Nenhum documento da escrituração traz itens (C170) e consolidação (C190) ' +
        'ao mesmo tempo. Sem os dois não há o que confrontar.',
      declaredCents: null,
      expectedCents: null,
      differenceCents: null,
      issues: [],
    };
  }

  const issues: IcmsIpiIssue[] = [];
  let somaItens = 0;
  let somaConsolidacao = 0;

  for (const documento of comparaveis) {
    const itens = documento.itemsIcmsCents;
    const consolidado = documento.analyticsIcmsCents;

    somaItens += itens;
    somaConsolidacao += consolidado;

    if (itens !== consolidado) {
      issues.push({
        subject: documento.subject,
        message:
          `Itens somam ${reais(itens)} de ICMS e a consolidação do documento ` +
          `declara ${reais(consolidado)}.`,
        differenceCents: consolidado - itens,
      });
    }
  }

  return {
    ...base,
    status: issues.length === 0 ? 'passed' : 'failed',
    notVerifiedReason: null,
    declaredCents: somaConsolidacao,
    expectedCents: somaItens,
    differenceCents: somaConsolidacao - somaItens,
    issues,
  };
}

/**
 * Soma dos analíticos contra os totais do `E110`, separados por débito e
 * crédito.
 *
 * São duas conferências e não uma porque um erro de débito e um de crédito do
 * mesmo tamanho se cancelariam no total, e o arquivo passaria. E cada lado tem a
 * sua lista de registros no guia: varejo (`C490`) só lança débito, e não impede
 * conferir os créditos.
 */
function conferirConsolidacaoContraApuracao(entrada: IcmsIpiInput): IcmsIpiCheck[] {
  const definicoes = [
    {
      checkId: 'c190-vs-e110-debitos',
      name: 'Débitos declarados contra as saídas',
      sentido: 'outbound' as const,
      declarado: entrada.icmsAssessment?.totalDebitsCents,
      rotulo: 'VL_TOT_DEBITOS',
      registros: COMPOEM_DEBITOS,
    },
    {
      checkId: 'c190-vs-e110-creditos',
      name: 'Créditos declarados contra as entradas',
      sentido: 'inbound' as const,
      declarado: entrada.icmsAssessment?.totalCreditsCents,
      rotulo: 'VL_TOT_CREDITOS',
      registros: COMPOEM_CREDITOS,
    },
  ];

  // Somado é o que tem linha: arquivo importado antes de um registro passar a
  // ser lido traz o registro na contagem e nenhuma linha dele.
  const somados = new Set(entrada.documents.map((d) => d.record));
  const validos = entrada.documents.filter((d) => !SITUACOES_SEM_IMPOSTO.has(d.situation));

  return definicoes.map(({ checkId, name, sentido, declarado, rotulo, registros }) => {
    const base = {
      checkId,
      name,
      rule:
        `${rotulo} do E110 deve corresponder à soma do VL_ICMS dos registros ` +
        `${registros.join(', ')} de ${sentido === 'outbound' ? 'saída' : 'entrada'}, ` +
        'com a transferência de saldo devedor (CFOP 1605 e 5605) do lado oposto' +
        (sentido === 'outbound' ? ' e sem os documentos extemporâneos (COD_SIT 01 e 07).' : '.') +
        ' Guia Prático 3.2.2, validação dos campos 02 e 06 do E110.',
      severity: 'high' as Severity,
    };

    if (declarado === undefined) {
      return semE110(base);
    }

    const naoCobertos = registros
      .filter((r) => (entrada.recordCounts[r] ?? 0) > 0 && !somados.has(r))
      .sort();

    if (naoCobertos.length > 0) {
      return {
        ...base,
        status: 'not_verified' as const,
        notVerifiedReason:
          `A escrituração traz ${naoCobertos.join(', ')}, que também lançam ICMS na ` +
          'apuração e este leitor ainda não soma. Comparar sem eles acusaria uma ' +
          'diferença que é limitação nossa, não erro da escrituração.',
        declaredCents: declarado,
        expectedCents: null,
        differenceCents: null,
        issues: [],
      };
    }

    const somado =
      sentido === 'outbound'
        ? validos
            .filter((d) => !EXTEMPORANEOS.has(d.situation))
            .reduce(
              (t, d) =>
                t + (d.operation === 'outbound' ? d.analyticsIcmsCents - d.transferIcmsCents : d.transferIcmsCents),
              0,
            )
        : validos.reduce(
            (t, d) =>
              t + (d.operation === 'inbound' ? d.analyticsIcmsCents - d.transferIcmsCents : d.transferIcmsCents),
            0,
          );

    return comparar(base, declarado, somado);
  });
}

function conferirDocumentosSemImposto(
  documentos: readonly IcmsIpiDocumentSummary[],
): IcmsIpiCheck {
  const base = {
    checkId: 'documento-sem-imposto-com-valor',
    name: 'Documento cancelado ou denegado com imposto',
    rule:
      'Documento cancelado (COD_SIT 02 e 03), denegado (04) ou de numeração ' +
      'inutilizada (05) não produz ICMS, e não deve trazer valor na consolidação.',
    severity: 'critical' as Severity,
  };

  const suspeitos = documentos.filter((d) => SITUACOES_SEM_IMPOSTO.has(d.situation));

  if (suspeitos.length === 0) {
    return {
      ...base,
      status: 'not_verified',
      notVerifiedReason:
        'A escrituração não traz documento cancelado, denegado ou de numeração ' +
        'inutilizada. Não havendo caso, não há conferência — e isso é diferente ' +
        'de ter conferido e passado.',
      declaredCents: null,
      expectedCents: null,
      differenceCents: null,
      issues: [],
    };
  }

  const issues: IcmsIpiIssue[] = [];
  let total = 0;

  for (const documento of suspeitos) {
    // A consolidação quando existe, o total do C100 quando não: são o mesmo
    // dinheiro declarado em dois lugares, e somá-los dobraria o valor em jogo.
    const icms = documento.hasAnalytics
      ? documento.analyticsIcmsCents
      : documento.documentIcmsCents;
    if (icms !== 0) {
      total += icms;
      issues.push({
        subject: documento.subject,
        message:
          `Documento com COD_SIT ${documento.situation} declara ${reais(icms)} de ` +
          'ICMS. Situação e valor não podem coexistir.',
        differenceCents: icms,
      });
    }
  }

  return {
    ...base,
    status: issues.length === 0 ? 'passed' : 'failed',
    notVerifiedReason: null,
    declaredCents: total,
    expectedCents: 0,
    differenceCents: total,
    issues,
  };
}

// ------------------------------------------------------------------ apoio

interface BaseDaConferencia {
  checkId: string;
  name: string;
  rule: string;
  severity: Severity;
}

function comparar(
  base: BaseDaConferencia,
  declarado: number,
  esperado: number,
): IcmsIpiCheck {
  const diferenca = declarado - esperado;

  return {
    ...base,
    status: diferenca === 0 ? 'passed' : 'failed',
    notVerifiedReason: null,
    declaredCents: declarado,
    expectedCents: esperado,
    differenceCents: diferenca,
    issues:
      diferenca === 0
        ? []
        : [
            {
              subject: base.checkId,
              message: `Declarado ${reais(declarado)}, a regra produz ${reais(esperado)}.`,
              differenceCents: diferenca,
            },
          ],
  };
}

function semE110(base: BaseDaConferencia): IcmsIpiCheck {
  return {
    ...base,
    status: 'not_verified',
    notVerifiedReason:
      'A escrituração não traz registro E110. Sem a apuração declarada não há o ' +
      'que conferir — o que não é o mesmo que apuração correta.',
    declaredCents: null,
    expectedCents: null,
    differenceCents: null,
    issues: [],
  };
}

function reais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
