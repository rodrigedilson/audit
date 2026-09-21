import { describe, it, expect } from 'vitest';
import {
  runTrails,
  summarize,
  MAX_ISSUES_POR_TRILHA,
  type ClassificationIssueRecord,
  type TrailDefinition,
  type TrailInput,
} from '../../../src/fiscal/reporting/audit-trails.js';

/** Subconjunto das trilhas reais, com as que exercitam cada origem. */
const DEFINICOES: TrailDefinition[] = [
  {
    trailId: 'xml_malformado',
    name: 'XML malformado',
    description: 'Arquivo recusado na leitura.',
    layer: 1,
    defaultSeverity: 'critical',
    taxScope: 'none',
    source: 'output_rejected',
    matches: ['schema_violation'],
  },
  {
    trailId: 'chave_inconsistente',
    name: 'Chave de acesso inconsistente',
    description: 'CNPJ do emitente divergente da chave.',
    layer: 2,
    defaultSeverity: 'critical',
    taxScope: 'none',
    source: 'output_rejected',
    matches: ['schema_violation'],
  },
  {
    trailId: 'documento_duplicado',
    name: 'Documento em duplicidade',
    description: 'Mesma chave enviada duas vezes.',
    layer: 2,
    defaultSeverity: 'medium',
    taxScope: 'both',
    source: 'output_rejected',
    matches: ['duplicate_document'],
  },
  {
    trailId: 'cclasstrib_vs_cst',
    name: 'cClassTrib incompatível com CST-IBS/CBS',
    description: 'Combinação inválida.',
    layer: 3,
    defaultSeverity: 'critical',
    taxScope: 'reform',
    source: 'item_classification',
    matches: ['code_incompatible'],
  },
  {
    trailId: 'codigo_nao_verificado',
    name: 'Código não verificado',
    description: 'Tabela de referência não carregada.',
    layer: 3,
    defaultSeverity: 'low',
    taxScope: 'both',
    source: 'item_classification',
    matches: ['not_verified'],
  },
  {
    trailId: 'regra_nao_publicada',
    name: 'Valor devido não determinável',
    description: 'Sem regra de creditamento.',
    layer: null,
    defaultSeverity: 'medium',
    taxScope: 'both',
    source: 'assessment',
    matches: ['rule_not_published'],
  },
  {
    trailId: 'competencia_nao_confirmada',
    name: 'Competência aberta no fechamento',
    description: 'Sem confirmação não há hash.',
    layer: null,
    defaultSeverity: 'high',
    taxScope: 'both',
    source: 'period_state',
    matches: ['open', 'assessed', 'reconciled'],
  },
];

const entrada = (over: Partial<TrailInput> = {}): TrailInput => ({
  definitions: DEFINICOES,
  rejections: [],
  classificationIssues: [],
  assessmentIssues: [],
  periodState: 'confirmed',
  referenceTablesLoaded: true,
  ...over,
});

const trilha = (resultados: ReturnType<typeof runTrails>, id: string) =>
  resultados.find((r) => r.trailId === id);

describe('runTrails — status', () => {
  it('trilha sem inconsistência passa', () => {
    const r = runTrails(entrada());

    expect(trilha(r, 'xml_malformado')?.status).toBe('passed');
    expect(trilha(r, 'xml_malformado')?.issuesCount).toBe(0);
  });

  it('severidade crítica com inconsistência reprova', () => {
    const r = runTrails(
      entrada({
        rejections: [
          { reason: 'schema_violation', layer: 1, details: 'XML truncado', subject: 'n1.xml', eventSeq: 1 },
        ],
      }),
    );

    expect(trilha(r, 'xml_malformado')?.status).toBe('failed');
  });

  it('severidade média com inconsistência apenas avisa', () => {
    const r = runTrails(
      entrada({
        rejections: [
          { reason: 'duplicate_document', layer: 2, details: 'ja recebido', subject: 'chave', eventSeq: 2 },
        ],
      }),
    );

    expect(trilha(r, 'documento_duplicado')?.status).toBe('warning');
  });

  it('competência confirmada faz a trilha de fechamento passar', () => {
    expect(trilha(runTrails(entrada({ periodState: 'confirmed' })), 'competencia_nao_confirmada')?.status).toBe(
      'passed',
    );
  });

  it.each(['open', 'assessed', 'reconciled'] as const)(
    'competência em %s reprova a trilha de fechamento',
    (estado) => {
      const t = trilha(runTrails(entrada({ periodState: estado })), 'competencia_nao_confirmada');

      expect(t?.status).toBe('failed');
      expect(t?.issues[0]?.message).toContain(estado);
    },
  );
});

describe('runTrails — a camada separa trilhas que compartilham o motivo', () => {
  /**
   * `xml_malformado` e `chave_inconsistente` casam o mesmo `schema_violation`.
   * Sem a camada, a mesma rejeição apareceria nas duas e a contagem dobraria.
   */
  it('rejeição da camada 1 não aparece na trilha da camada 2', () => {
    const r = runTrails(
      entrada({
        rejections: [
          { reason: 'schema_violation', layer: 1, details: 'XML truncado', subject: 'n1.xml', eventSeq: 1 },
        ],
      }),
    );

    expect(trilha(r, 'xml_malformado')?.issuesCount).toBe(1);
    expect(trilha(r, 'chave_inconsistente')?.issuesCount).toBe(0);
  });

  it('rejeição da camada 2 vai para a trilha da camada 2', () => {
    const r = runTrails(
      entrada({
        rejections: [
          { reason: 'schema_violation', layer: 2, details: 'CNPJ divergente', subject: 'chave', eventSeq: 1 },
        ],
      }),
    );

    expect(trilha(r, 'xml_malformado')?.issuesCount).toBe(0);
    expect(trilha(r, 'chave_inconsistente')?.issuesCount).toBe(1);
  });
});

describe('runTrails — tabelas oficiais ausentes', () => {
  const comIncompatibilidade: ClassificationIssueRecord[] = [
    {
      itemId: 'SKU-1',
      reason: 'code_incompatible',
      severity: 'critical',
      message: 'cClassTrib incompatível',
      documentsAffected: 12,
      amountAtStakeCents: 500_000,
    },
  ];

  /**
   * É a decisão que mantém o Book honesto: sem tabela oficial carregada, a
   * trilha de código não "passou" — não foi conferida. Reportar `passed` daria
   * ao escritório a impressão de validação que não houve.
   */
  it('trilha de código fica not_applicable, não passed', () => {
    const r = runTrails(entrada({ referenceTablesLoaded: false }));

    expect(trilha(r, 'cclasstrib_vs_cst')?.status).toBe('not_applicable');
  });

  it('a trilha de "não verificado" continua ativa, para a lacuna aparecer', () => {
    const r = runTrails(
      entrada({
        referenceTablesLoaded: false,
        classificationIssues: [
          {
            itemId: 'SKU-1',
            reason: 'not_verified',
            severity: 'low',
            message: 'NCM não verificado',
            documentsAffected: 3,
            amountAtStakeCents: 0,
          },
        ],
      }),
    );

    expect(trilha(r, 'codigo_nao_verificado')?.status).toBe('warning');
    expect(trilha(r, 'codigo_nao_verificado')?.issuesCount).toBe(1);
  });

  it('com as tabelas carregadas, a trilha de código volta a avaliar', () => {
    const r = runTrails(
      entrada({ referenceTablesLoaded: true, classificationIssues: comIncompatibilidade }),
    );

    expect(trilha(r, 'cclasstrib_vs_cst')?.status).toBe('failed');
  });
});

describe('runTrails — propagação e valor em risco', () => {
  it('soma notas afetadas e valor em risco da trilha', () => {
    const r = runTrails(
      entrada({
        classificationIssues: [
          {
            itemId: 'SKU-1',
            reason: 'code_incompatible',
            severity: 'critical',
            message: 'incompatível',
            documentsAffected: 12,
            amountAtStakeCents: 500_000,
          },
          {
            itemId: 'SKU-2',
            reason: 'code_incompatible',
            severity: 'critical',
            message: 'incompatível',
            documentsAffected: 8,
            amountAtStakeCents: 250_000,
          },
        ],
      }),
    );

    const t = trilha(r, 'cclasstrib_vs_cst');
    expect(t?.issuesCount).toBe(2);
    expect(t?.documentsAffected).toBe(20);
    expect(t?.amountAtStakeCents).toBe(750_000);
  });

  /** Um CNPJ com milhares de itens errados geraria um Book que ninguém lê. */
  it('amostra o detalhe mas mantém a contagem exata', () => {
    const muitos: ClassificationIssueRecord[] = Array.from({ length: 200 }, (_, i) => ({
      itemId: `SKU-${i}`,
      reason: 'code_incompatible',
      severity: 'critical' as const,
      message: 'incompatível',
      documentsAffected: 1,
      amountAtStakeCents: 100,
    }));

    const t = trilha(runTrails(entrada({ classificationIssues: muitos })), 'cclasstrib_vs_cst');

    expect(t?.issuesCount).toBe(200);
    expect(t?.issues).toHaveLength(MAX_ISSUES_POR_TRILHA);
    // O total continua exato mesmo com o detalhe amostrado.
    expect(t?.documentsAffected).toBe(200);
    expect(t?.amountAtStakeCents).toBe(20_000);
  });
});

describe('runTrails — ordenação', () => {
  it('reprovadas primeiro, depois avisos, depois não aplicáveis e aprovadas', () => {
    const r = runTrails(
      entrada({
        rejections: [
          { reason: 'duplicate_document', layer: 2, details: 'dup', subject: 'c', eventSeq: 1 },
          { reason: 'schema_violation', layer: 1, details: 'xml', subject: 'n', eventSeq: 2 },
        ],
        periodState: 'assessed',
      }),
    );

    const ordem = r.map((t) => t.status);
    expect(ordem.indexOf('failed')).toBe(0);
    expect(ordem.lastIndexOf('failed')).toBeLessThan(ordem.indexOf('warning'));
    expect(ordem.indexOf('warning')).toBeLessThan(ordem.indexOf('passed'));
  });

  it('entre reprovadas, a crítica vem antes da alta', () => {
    const r = runTrails(
      entrada({
        rejections: [{ reason: 'schema_violation', layer: 1, details: 'xml', subject: 'n', eventSeq: 1 }],
        periodState: 'open',
      }),
    );

    const reprovadas = r.filter((t) => t.status === 'failed');
    expect(reprovadas[0]?.severity).toBe('critical');
    expect(reprovadas[1]?.severity).toBe('high');
  });

  it('a ordem é estável entre execuções, porque o Book carrega hash', () => {
    const e = entrada({
      classificationIssues: [
        {
          itemId: 'SKU-1',
          reason: 'code_incompatible',
          severity: 'critical',
          message: 'x',
          documentsAffected: 1,
          amountAtStakeCents: 1,
        },
      ],
    });

    expect(runTrails(e)).toEqual(runTrails(e));
  });
});

describe('summarize', () => {
  it('conta por status e soma o valor em risco', () => {
    const r = runTrails(
      entrada({
        rejections: [{ reason: 'schema_violation', layer: 1, details: 'x', subject: 'n', eventSeq: 1 }],
        classificationIssues: [
          {
            itemId: 'SKU-1',
            reason: 'code_incompatible',
            severity: 'critical',
            message: 'x',
            documentsAffected: 2,
            amountAtStakeCents: 300_000,
          },
        ],
        periodState: 'assessed',
      }),
    );

    const resumo = summarize(r);

    expect(resumo.failed).toBe(3);
    expect(resumo.amountAtStakeCents).toBe(300_000);
    expect(resumo.passed + resumo.warning + resumo.failed + resumo.not_applicable).toBe(
      DEFINICOES.length,
    );
  });

  it('tudo limpo dá só aprovadas', () => {
    const resumo = summarize(runTrails(entrada()));

    expect(resumo.failed).toBe(0);
    expect(resumo.warning).toBe(0);
    expect(resumo.passed).toBe(DEFINICOES.length);
  });
});
