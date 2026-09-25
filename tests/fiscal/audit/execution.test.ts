import { describe, expect, it } from 'vitest';

import { execute, findingId, type ExecutionInput } from '../../../src/fiscal/audit/execution.js';
import { censo, type AuditProcedure, type ExaminableSubject } from '../../../src/fiscal/audit/audit-procedure.js';
import { emptyCodeTables } from '../../../src/fiscal/catalog/code-validation.js';
import type { EvaluationCriterion } from '../../../src/fiscal/shared/evaluation-criterion.js';
import { TRILHAS_INICIAIS } from '../../../src/fiscal/audit/trilhas-iniciais.js';

const CNPJ = '11222333000181';
/** Chave válida: os 43 primeiros mais o dígito que fecha. */
const CHAVE_OK = '35270111222333000181550010000000011000000013';

const criterio = (over: Partial<EvaluationCriterion> = {}): EvaluationCriterion => ({
  criterionId: 'lc-214-credito-documento-habil',
  kind: 'lei_complementar',
  citation: 'LC 214/2025, art. 156-A',
  parameter: 'O crédito exige documento hábil.',
  validFrom: '2026-01-01',
  validTo: null,
  sourceRef: 'https://www.planalto.gov.br/…',
  verified: true,
  ...over,
});

const trilha = (over: Partial<AuditProcedure> = {}): AuditProcedure => ({
  procedureId: 'credito-sem-documento-habil',
  name: 'Crédito sem documento hábil',
  description: '…',
  population: 'creditos_de_entrada',
  sampling: censo(),
  verifications: ['v1_fidedignidade_e_atores'],
  criterionId: 'lc-214-credito-documento-habil',
  appliesToRegimes: null,
  reversalPolicy: 'propor_estorno',
  active: true,
  ...over,
});

const sujeito = (over: Partial<ExaminableSubject> = {}): ExaminableSubject => ({
  subject: CHAVE_OK,
  subjectKind: 'creditos_de_entrada',
  accessKey: CHAVE_OK,
  issuerCnpj: '11222333000181',
  recipientCnpj: CNPJ,
  issuedAt: '2027-01-15',
  documentPeriod: '2027-01',
  authorizationProtocol: '135270000000001',
  cancelled: false,
  denied: false,
  appropriatedPeriod: '2027-01',
  classification: null,
  ncmFlags: null,
  cnaePrimary: null,
  usageKind: null,
  creditState: 'conditioned',
  amountCents: 120_000,
  ...over,
});

const entrada = (over: Partial<ExecutionInput> = {}): ExecutionInput => ({
  procedure: trilha(),
  criterion: criterio(),
  period: '2027-01',
  population: [sujeito()],
  periodBaseCents: 1_000_000,
  tables: emptyCodeTables(),
  tablesLoaded: false,
  cnpj: CNPJ,
  today: '2027-02-10',
  previousFindings: [],
  ...over,
});

describe('execute — censo', () => {
  it('examina a população inteira, e examinados é igual a população', () => {
    const r = execute(entrada({ population: [sujeito(), sujeito({ subject: 'b' })] }));

    expect(r.populationSize).toBe(2);
    expect(r.examinedCount).toBe(2);
    expect(r.sampling.technique).toBe('censo');
  });

  it('documento íntegro e com o CNPJ como parte não gera achado', () => {
    const r = execute(entrada());

    expect(r.findings).toHaveLength(0);
    expect(r.status).toBe('completed');
    expect(r.totalImpactCents).toBe(0);
  });

  it('chave que não fecha vira achado com o impacto do crédito', () => {
    const quebrada = CHAVE_OK.slice(0, 43) + '9';
    const r = execute(entrada({ population: [sujeito({ accessKey: quebrada, subject: quebrada })] }));

    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.failed).toEqual(['v1_fidedignidade_e_atores']);
    expect(r.findings[0]!.impactCents).toBe(120_000);
    expect(r.findings[0]!.impactSide).toBe('credito_a_estornar');
    expect(r.totalImpactCents).toBe(120_000);
  });

  it('CNPJ que não é parte da operação vira achado', () => {
    // O emitente está gravado na chave de acesso, então quem muda é o CNPJ sob
    // exame: é o caso do documento de terceiro que entrou na pasta errada.
    const r = execute(
      entrada({ cnpj: '99888777000166', population: [sujeito()] }),
    );

    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.verifications[0]!.rationale).toContain('não é emitente nem destinatário');
  });
});

describe('execute — o que torna a execução inconclusiva', () => {
  /**
   * O ponto do módulo: sem parâmetro de comparação o teste não conclui nada, e
   * dizer "zero achados" seria vender conferência que não aconteceu.
   */
  it('critério ausente não examina ninguém e diz por quê', () => {
    const r = execute(entrada({ criterion: null }));

    expect(r.status).toBe('inconclusive');
    expect(r.examinedCount).toBe(0);
    expect(r.findings).toHaveLength(0);
    expect(r.inconclusiveReason).toContain('não está carregado');
  });

  it('critério não conferido produz achado que não afirma', () => {
    const quebrada = CHAVE_OK.slice(0, 43) + '9';
    const r = execute(
      entrada({
        criterion: criterio({ verified: false, sourceRef: null }),
        population: [sujeito({ accessKey: quebrada })],
      }),
    );

    expect(r.status).toBe('inconclusive');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.assertable).toBe(false);
    expect(r.inconclusiveReason).toContain('não foi conferido');
  });

  it('verificação que não pôde rodar deixa a execução inconclusiva, não completa', () => {
    // V5 sempre não verifica enquanto a destinação não é declarada.
    const r = execute(
      entrada({ procedure: trilha({ verifications: ['v5_relacao_com_a_atividade'] }) }),
    );

    expect(r.status).toBe('inconclusive');
    expect(r.findings).toHaveLength(0);
    expect(r.inconclusiveReason).toContain('não puderam ser inteiramente verificados');
  });

  it('tabelas oficiais não carregadas não fazem a classificação passar', () => {
    const r = execute(
      entrada({
        procedure: trilha({ verifications: ['v3_lancamento_correto'] }),
        population: [sujeito({ classification: { effectiveFrom: '2027-01-01', ncm: '12345678' } })],
      }),
    );

    expect(r.status).toBe('inconclusive');
    expect(r.findings).toHaveLength(0);
  });
});

describe('execute — reexecução', () => {
  it('o identificador do achado é determinístico', () => {
    expect(findingId('t', '2027-01', 'x')).toBe('t:2027-01:x');

    const quebrada = CHAVE_OK.slice(0, 43) + '9';
    const uma = execute(entrada({ population: [sujeito({ accessKey: quebrada })] }));
    const outra = execute(entrada({ population: [sujeito({ accessKey: quebrada })] }));

    expect(uma.findings[0]!.findingId).toBe(outra.findings[0]!.findingId);
  });

  /**
   * Rebaixar a `open` a cada rodada faria o contador revisar de novo o que já
   * revisou — e a trilha roda todo mês.
   */
  it('preserva a revisão humana de um achado que persiste', () => {
    const quebrada = CHAVE_OK.slice(0, 43) + '9';
    const id = findingId('credito-sem-documento-habil', '2027-01', quebrada);
    const r = execute(
      entrada({
        population: [sujeito({ accessKey: quebrada, subject: quebrada })],
        previousFindings: [{ findingId: id, status: 'accepted' }],
      }),
    );

    expect(r.findings[0]!.status).toBe('accepted');
  });

  it('sujeito que passou a conferir entra em resolvidos', () => {
    const id = findingId('credito-sem-documento-habil', '2027-01', CHAVE_OK);
    const r = execute(entrada({ previousFindings: [{ findingId: id, status: 'accepted' }] }));

    expect(r.findings).toHaveLength(0);
    expect(r.resolvedFindingIds).toEqual([id]);
  });
});

describe('execute — risco sobre a população', () => {
  /**
   * A probabilidade é do conjunto, não do sujeito: uma falha em duas notas e
   * uma falha em mil não representam o mesmo risco, e o achado isolado não
   * saberia a diferença.
   */
  it('a probabilidade sai da frequência na população inteira', () => {
    const quebrada = CHAVE_OK.slice(0, 43) + '9';
    const muitos = Array.from({ length: 99 }, (_, i) => sujeito({ subject: `ok-${i}` }));
    const r = execute(
      entrada({ population: [sujeito({ accessKey: quebrada, subject: quebrada }), ...muitos] }),
    );

    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.risk.observed).toEqual({ failures: 1, examined: 100 });
    expect(r.findings[0]!.risk.likelihood).toBe(1);
  });
});

describe('TRILHAS_INICIAIS', () => {
  it('todas em censo — o sistema tem a população inteira', () => {
    for (const t of TRILHAS_INICIAIS) {
      expect(t.sampling.technique, t.procedureId).toBe('censo');
    }
  });

  it('toda trilha cita um critério e tem verificação declarada', () => {
    for (const t of TRILHAS_INICIAIS) {
      expect(t.criterionId.trim().length, t.procedureId).toBeGreaterThan(0);
      expect(t.verifications.length, t.procedureId).toBeGreaterThan(0);
    }
  });

  it('a trilha que depende de dado inexistente nasce desligada, e não omitida', () => {
    const usoEConsumo = TRILHAS_INICIAIS.find((t) => t.procedureId === 'uso-e-consumo-com-credito');

    expect(usoEConsumo).toBeDefined();
    expect(usoEConsumo!.active).toBe(false);
  });

  it('os identificadores são únicos', () => {
    const ids = TRILHAS_INICIAIS.map((t) => t.procedureId);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
