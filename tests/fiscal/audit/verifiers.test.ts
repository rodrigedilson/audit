import { describe, expect, it } from 'vitest';

import {
  verificarAutorizacao,
  verificarDataDoLancamento,
  verificarFidedignidade,
  verificarLancamento,
  verificarRelacaoComAtividade,
  VERIFIERS,
  type VerifierContext,
} from '../../../src/fiscal/audit/verifiers.js';
import type { ExaminableSubject } from '../../../src/fiscal/audit/audit-procedure.js';
import { emptyCodeTables } from '../../../src/fiscal/catalog/code-validation.js';
import { VERIFICATIONS } from '../../../src/fiscal/audit/verifications.js';
import type { EvaluationCriterion } from '../../../src/fiscal/shared/evaluation-criterion.js';

const CNPJ = '11222333000181';
const CHAVE_OK = '35270111222333000181550010000000011000000013';

const criterion: EvaluationCriterion = {
  criterionId: 'lc-214-credito-documento-habil',
  kind: 'lei_complementar',
  citation: 'LC 214/2025, art. 156-A',
  parameter: 'O crédito exige documento hábil.',
  validFrom: '2026-01-01',
  validTo: null,
  sourceRef: 'https://www.planalto.gov.br/…',
  verified: true,
};

const ctx = (over: Partial<VerifierContext> = {}): VerifierContext => ({
  cnpj: CNPJ,
  criterion,
  tables: emptyCodeTables(),
  tablesLoaded: false,
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

describe('V1 — fidedignidade e atores', () => {
  it('documento íntegro com o CNPJ como destinatário passa', () => {
    const r = verificarFidedignidade(sujeito(), ctx());

    expect(r.outcome).toBe('pass');
    expect(r.criterion?.citation).toBe('LC 214/2025, art. 156-A');
  });

  it('sem chave de acesso não verifica, em vez de passar', () => {
    expect(verificarFidedignidade(sujeito({ accessKey: null }), ctx()).outcome).toBe('not_verified');
  });

  it('dígito verificador que não fecha reprova', () => {
    const quebrada = CHAVE_OK.slice(0, 43) + '9';
    const r = verificarFidedignidade(sujeito({ accessKey: quebrada }), ctx());

    expect(r.outcome).toBe('fail');
    expect(r.compared[0]?.matches).toBe(false);
  });

  it('emitente declarado diferente do que está na chave reprova', () => {
    const r = verificarFidedignidade(sujeito({ issuerCnpj: '99888777000166' }), ctx());

    expect(r.outcome).toBe('fail');
    expect(r.rationale).toContain('não é o que está na chave');
  });

  it('CNPJ que não é emitente nem destinatário reprova', () => {
    const r = verificarFidedignidade(sujeito(), ctx({ cnpj: '99888777000166' }));

    expect(r.outcome).toBe('fail');
    expect(r.rationale).toContain('não é emitente nem destinatário');
  });
});

describe('V2 — data do documento contra a data do lançamento', () => {
  it('apropriado na competência da emissão passa', () => {
    expect(verificarDataDoLancamento(sujeito(), ctx()).outcome).toBe('pass');
  });

  it('apropriado em competência posterior é crédito extemporâneo', () => {
    const r = verificarDataDoLancamento(sujeito({ appropriatedPeriod: '2027-03' }), ctx());

    expect(r.outcome).toBe('fail');
    expect(r.rationale).toContain('extemporâneo');
  });

  it('sem uma das competências não verifica', () => {
    expect(
      verificarDataDoLancamento(sujeito({ appropriatedPeriod: null }), ctx()).outcome,
    ).toBe('not_verified');
  });
});

describe('V3 — correção do lançamento', () => {
  it('sem classificação não verifica', () => {
    expect(verificarLancamento(sujeito(), ctx()).outcome).toBe('not_verified');
  });

  /**
   * A guarda que o produto já aplica em `code-validation.ts`: sem tabela
   * carregada nada foi comparado, e dizer `pass` daria ao escritório a
   * impressão de que o cadastro foi validado.
   */
  it('tabelas oficiais ausentes não viram aprovação', () => {
    const r = verificarLancamento(
      sujeito({ classification: { effectiveFrom: '2027-01-01', ncm: '12345678' } }),
      ctx({ tablesLoaded: false }),
    );

    expect(r.outcome).toBe('not_verified');
    expect(r.rationale).toContain('não estão carregadas');
  });

  it('classificação malformada reprova quando há tabelas', () => {
    const r = verificarLancamento(
      sujeito({ classification: { effectiveFrom: '2027-01-01', ncm: 'ABC' } }),
      ctx({ tablesLoaded: true }),
    );

    expect(r.outcome).toBe('fail');
    expect(r.compared.length).toBeGreaterThan(0);
  });
});

describe('V4 — autorização competente', () => {
  it('cancelado reprova', () => {
    const r = verificarAutorizacao(sujeito({ cancelled: true }), ctx());

    expect(r.outcome).toBe('fail');
    expect(r.rationale).toContain('cancelado ou denegado');
  });

  it('denegado reprova', () => {
    expect(verificarAutorizacao(sujeito({ denied: true }), ctx()).outcome).toBe('fail');
  });

  it('sem protocolo coletado não verifica', () => {
    expect(
      verificarAutorizacao(sujeito({ authorizationProtocol: null }), ctx()).outcome,
    ).toBe('not_verified');
  });

  /**
   * A honestidade que custa caro: com protocolo presente e situação atual
   * desconhecida, dizer `pass` afirmaria que o documento não foi cancelado
   * depois — que é justamente o que não se sabe.
   */
  it('protocolo presente com situação atual desconhecida não passa', () => {
    const r = verificarAutorizacao(sujeito({ cancelled: null }), ctx());

    expect(r.outcome).toBe('not_verified');
    expect(r.rationale).toContain('pode ter sido cancelado depois');
  });

  it('autorizado e sem cancelamento passa', () => {
    expect(verificarAutorizacao(sujeito(), ctx()).outcome).toBe('pass');
  });
});

describe('V5 — relação com a atividade', () => {
  /**
   * Não existe tabela oficial que derive insumo × uso e consumo do NCM: a lei
   * define pela atividade do contribuinte. Deduzir por CNAE produziria glosa
   * inventada no item mais caro da nota.
   */
  it('sem declaração de destinação não verifica, e diz por quê', () => {
    const r = verificarRelacaoComAtividade(sujeito(), ctx());

    expect(r.outcome).toBe('not_verified');
    expect(r.rationale).toContain('não há tabela oficial');
  });

  it('uso e consumo com crédito apropriado reprova', () => {
    const r = verificarRelacaoComAtividade(
      sujeito({ usageKind: 'uso_e_consumo', creditState: 'conditioned' }),
      ctx(),
    );

    expect(r.outcome).toBe('fail');
  });

  it('uso e consumo sem crédito passa', () => {
    expect(
      verificarRelacaoComAtividade(sujeito({ usageKind: 'uso_e_consumo', creditState: null }), ctx())
        .outcome,
    ).toBe('pass');
  });

  it('insumo com crédito passa', () => {
    expect(
      verificarRelacaoComAtividade(sujeito({ usageKind: 'insumo' }), ctx()).outcome,
    ).toBe('pass');
  });
});

describe('registro de verificadores', () => {
  it('as cinco estão registradas, e cada uma devolve a verificação que diz executar', () => {
    for (const v of VERIFICATIONS) {
      const verifier = VERIFIERS[v];

      expect(verifier, v).toBeDefined();
      expect(verifier!(sujeito(), ctx()).verification).toBe(v);
    }
  });

  it('todo resultado traz motivo não vazio — verificação muda não explica nada', () => {
    for (const v of VERIFICATIONS) {
      expect(VERIFIERS[v]!(sujeito(), ctx()).rationale.trim().length, v).toBeGreaterThan(0);
    }
  });
});
