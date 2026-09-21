import { describe, it, expect } from 'vitest';
import {
  validateClassification,
  derivarSaude,
  emptyCodeTables,
  type Classification,
  type CodeTables,
} from '../../../src/fiscal/catalog/code-validation.js';

/**
 * Tabelas de referência com um punhado de códigos. Não são a tabela oficial
 * completa — são o suficiente para exercitar as regras, e a carga da tabela
 * oficial é tarefa de dado, não de código.
 */
function tabelas(over: Partial<CodeTables> = {}): CodeTables {
  return {
    ...emptyCodeTables(),
    ncm: new Set(['73181500', '84713012', '00000000']),
    nbs: new Set(['115011000']),
    cfop: new Set(['5102', '5933', '1102']),
    cstIcms: new Set(['00', '20', '40', '102']),
    cstPisCofins: new Set(['01', '04', '06']),
    cstIbsCbs: new Set(['000', '200', '400']),
    cclasstribCst: new Map([
      ['000001', new Set(['000'])],
      ['000002', new Set(['000'])],
      ['200001', new Set(['200'])],
      ['400001', new Set(['400'])],
      // Um cClassTrib que serve a dois CSTs, para provar que a regra não é
      // "prefixo igual ao CST".
      ['900001', new Set(['000', '200'])],
    ]),
    ncmFlags: new Map([
      ['73181500', { monophasic: false, taxSubstitution: true }],
      ['84713012', { monophasic: true, taxSubstitution: false }],
    ]),
    ...over,
  };
}

const completa = (over: Partial<Classification> = {}): Classification => ({
  effectiveFrom: '2027-01',
  ncm: '73181500',
  cfopDefault: '5102',
  cstIcms: '00',
  cstPisCofins: '01',
  cstIbsCbs: '000',
  cclasstrib: '000001',
  justification: 'Cadastro conferido com a nota do fornecedor',
  ...over,
});

describe('validateClassification — classificação correta', () => {
  it('aprova item com todos os códigos válidos e compatíveis', () => {
    const r = validateClassification(completa(), tabelas());

    expect(r.health).toBe('ok');
    expect(r.issues).toEqual([]);
  });

  it('devolve as marcações do NCM como informação, não como inconsistência', () => {
    const r = validateClassification(completa({ ncm: '84713012' }), tabelas());

    expect(r.health).toBe('ok');
    expect(r.flags).toEqual({ monophasic: true, taxSubstitution: false });
  });

  it('omite flags quando o NCM não está na tabela de marcações', () => {
    const r = validateClassification(completa({ ncm: '00000000' }), tabelas());

    expect(r.flags).toBeUndefined();
  });
});

describe('validateClassification — formato', () => {
  it.each([
    ['ncm', '7318150', 'NCM'],
    ['cfopDefault', '51020', 'CFOP'],
    ['cclasstrib', '00001', 'cClassTrib'],
    ['cstIbsCbs', '0000', 'CST-IBS/CBS'],
    ['cstPisCofins', '001', 'CST-PIS/Cofins'],
  ])('recusa %s fora do formato', (campo, valor, rotulo) => {
    const r = validateClassification(completa({ [campo]: valor }), tabelas());

    expect(r.health).toBe('error');
    const issue = r.issues.find((i) => i.reason === 'schema_violation');
    expect(issue?.message).toContain(rotulo);
    expect(issue?.message).toContain('fora do formato');
  });

  it('recusa NCM com letra', () => {
    const r = validateClassification(completa({ ncm: '7318150A' }), tabelas());

    expect(r.issues.some((i) => i.reason === 'schema_violation')).toBe(true);
  });

  /** Cobrar existência de um código malformado só duplicaria a mensagem. */
  it('não cobra existência de código que já falhou no formato', () => {
    const r = validateClassification(completa({ ncm: '123' }), tabelas());

    expect(r.issues.filter((i) => i.field === 'ncm')).toHaveLength(1);
    expect(r.issues[0]!.reason).toBe('schema_violation');
  });

  it('aceita CSOSN de 3 dígitos no campo de CST-ICMS', () => {
    const r = validateClassification(completa({ cstIcms: '102' }), tabelas());

    expect(r.issues.filter((i) => i.field === 'cstIcms')).toEqual([]);
  });
});

describe('validateClassification — existência nas tabelas oficiais', () => {
  it('acusa NCM inexistente como erro', () => {
    const r = validateClassification(completa({ ncm: '99999999' }), tabelas());

    expect(r.health).toBe('error');
    const issue = r.issues.find((i) => i.field === 'ncm');
    expect(issue?.reason).toBe('unknown_code');
    expect(issue?.severity).toBe('high');
  });

  it('acusa CFOP inexistente', () => {
    const r = validateClassification(completa({ cfopDefault: '9999' }), tabelas());

    expect(r.issues.some((i) => i.reason === 'unknown_code' && i.field === 'cfopDefault')).toBe(
      true,
    );
  });

  it('ignora campos não informados', () => {
    const { nbs: _nbs, ...semNbs } = completa();
    const r = validateClassification(semNbs, tabelas());

    expect(r.issues.some((i) => i.field === 'nbs')).toBe(false);
  });

  /**
   * A decisão que torna o resultado honesto: tabela vazia não aprova. Validar
   * contra tabela vazia daria aprovação a qualquer código, o que é pior do que
   * não validar.
   */
  it('tabela de referência vazia devolve não-verificado, nunca ok', () => {
    const r = validateClassification(completa(), emptyCodeTables());

    expect(r.health).not.toBe('ok');
    expect(r.health).toBe('warning');
    expect(r.issues.every((i) => i.reason === 'not_verified')).toBe(true);
    expect(r.issues.some((i) => i.message.includes('não verificado'))).toBe(true);
  });

  it('não-verificado é aviso, não erro: não bloqueia o escritório', () => {
    const r = validateClassification(completa(), emptyCodeTables());

    expect(r.issues.every((i) => i.severity === 'low')).toBe(true);
  });

  it('a sugestão de não-verificado diz onde carregar a tabela', () => {
    const r = validateClassification(completa({ ncm: '73181500' }), emptyCodeTables());

    expect(r.issues.find((i) => i.field === 'ncm')?.suggestedFix).toContain('fiscal_codes');
  });
});

describe('validateClassification — cClassTrib × CST-IBS/CBS', () => {
  /**
   * O erro de mérito: os dois códigos existem, a combinação não. A SEFAZ
   * autoriza a emissão e a apuração pune — é o caso que o produto existe para
   * pegar, e por isso é `critical`.
   */
  it('acusa par incompatível como crítico', () => {
    const r = validateClassification(
      completa({ cstIbsCbs: '200', cclasstrib: '000001' }),
      tabelas(),
    );

    expect(r.health).toBe('error');
    const issue = r.issues.find((i) => i.reason === 'code_incompatible');
    expect(issue?.severity).toBe('critical');
    expect(issue?.message).toContain("cClassTrib '000001'");
    expect(issue?.message).toContain("CST-IBS/CBS '200'");
  });

  it('a mensagem diz com quais CST aquele cClassTrib vale', () => {
    const issue = validateClassification(
      completa({ cstIbsCbs: '400', cclasstrib: '000001' }),
      tabelas(),
    ).issues.find((i) => i.reason === 'code_incompatible');

    expect(issue?.message).toContain('vale para: 000');
    expect(issue?.suggestedFix).toContain('000');
  });

  it('aceita cClassTrib que serve a mais de um CST', () => {
    const tab = tabelas();

    for (const cst of ['000', '200']) {
      const r = validateClassification(completa({ cstIbsCbs: cst, cclasstrib: '900001' }), tab);
      expect(r.issues.some((i) => i.reason === 'code_incompatible')).toBe(false);
    }
  });

  /** Prova que a regra não é "prefixo do cClassTrib igual ao CST". */
  it('não infere compatibilidade por prefixo', () => {
    const r = validateClassification(
      completa({ cstIbsCbs: '900', cclasstrib: '900001' }),
      tabelas(),
    );

    // 900 não está na tabela de CST, e 900001 não é pareado com 900.
    expect(r.issues.some((i) => i.reason === 'unknown_code' && i.field === 'cstIbsCbs')).toBe(true);
    expect(r.issues.some((i) => i.reason === 'code_incompatible')).toBe(true);
  });

  it('acusa cClassTrib inexistente na tabela de pareamento', () => {
    const r = validateClassification(completa({ cclasstrib: '999999' }), tabelas());

    const issue = r.issues.find((i) => i.field === 'cclasstrib');
    expect(issue?.reason).toBe('unknown_code');
    expect(issue?.suggestedFix).toContain('IT RT 2025.002');
  });

  it('não verifica compatibilidade sem a tabela de pareamento', () => {
    const r = validateClassification(
      completa(),
      tabelas({ cclasstribCst: new Map() }),
    );

    const issue = r.issues.find((i) => i.reason === 'not_verified' && i.field === 'cclasstrib');
    expect(issue?.suggestedFix).toContain('cclasstrib_cst');
  });

  it('não reclama de compatibilidade quando falta um dos dois códigos', () => {
    const { cclasstrib: _c, ...semCclass } = completa();
    const r = validateClassification(semCclass, tabelas());

    expect(r.issues.some((i) => i.reason === 'code_incompatible')).toBe(false);
  });
});

describe('validateClassification — prontidão para a reforma', () => {
  it('avisa quando falta CST-IBS/CBS e cClassTrib', () => {
    const { cstIbsCbs: _a, cclasstrib: _b, ...legado } = completa();
    const r = validateClassification(legado, tabelas());

    const issue = r.issues.find((i) => i.reason === 'missing_reform_classification');
    expect(issue?.severity).toBe('medium');
    expect(issue?.message).toContain('CST-IBS/CBS e cClassTrib');
    expect(issue?.suggestedFix).toContain('2027-01');
  });

  it('nomeia só o que falta', () => {
    const { cclasstrib: _c, ...semCclass } = completa();
    const issue = validateClassification(semCclass, tabelas()).issues.find(
      (i) => i.reason === 'missing_reform_classification',
    );

    expect(issue?.message).toContain('cClassTrib');
    expect(issue?.message).not.toContain('CST-IBS/CBS e');
  });

  /** Falta de classificação nova é aviso, não erro: hoje ainda não é exigível. */
  it('item só com códigos do sistema atual fica em warning, não error', () => {
    const { cstIbsCbs: _a, cclasstrib: _b, ...legado } = completa();

    expect(validateClassification(legado, tabelas()).health).toBe('warning');
  });
});

describe('derivarSaude', () => {
  it('sem inconsistência é ok', () => {
    expect(derivarSaude([])).toBe('ok');
  });

  it.each(['critical', 'high'] as const)('%s vira error', (severity) => {
    expect(derivarSaude([{ reason: 'unknown_code', severity, field: 'x', message: 'm' }])).toBe(
      'error',
    );
  });

  it.each(['medium', 'low'] as const)('%s vira warning', (severity) => {
    expect(derivarSaude([{ reason: 'not_verified', severity, field: 'x', message: 'm' }])).toBe(
      'warning',
    );
  });

  it('a pior severidade manda', () => {
    expect(
      derivarSaude([
        { reason: 'not_verified', severity: 'low', field: 'a', message: 'm' },
        { reason: 'code_incompatible', severity: 'critical', field: 'b', message: 'm' },
      ]),
    ).toBe('error');
  });
});
