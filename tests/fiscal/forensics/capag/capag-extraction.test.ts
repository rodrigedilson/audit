import { describe, it, expect } from 'vitest';
import {
  conferirExtracao,
  lerDinheiro,
  lerNumero,
  normalizar,
} from '../../../../src/fiscal/forensics/capag/capag-extraction.js';
import { lerExtracao } from '../../../../src/fiscal/forensics/capag/claude-capag-extractor.js';
import { DEMONSTRATIVO_TEXTO, extracaoDoDemonstrativo } from '../../../helpers/capag.js';

describe('leitura de números em pt-BR', () => {
  it('dinheiro', () => {
    expect(lerDinheiro('R$ 1.234.567,89')).toBe(123_456_789);
    expect(lerDinheiro('R$ 950.000,00')).toBe(95_000_000);
    expect(lerDinheiro('1234,5')).toBe(123_450);
    expect(lerDinheiro('-R$ 10,00')).toBe(-1_000);
    expect(lerDinheiro('(10,00)')).toBe(-1_000);
    expect(lerDinheiro('mil reais')).toBeNull();
  });

  it('coeficiente, percentual e multiplicador', () => {
    expect(lerNumero('0,10')).toBe(0.1);
    expect(lerNumero('10%')).toBe(0.1);
    expect(lerNumero('10,5 %')).toBe(0.105);
    expect(lerNumero('5')).toBe(5);
    expect(lerNumero('5x')).toBe(5);
    expect(lerNumero('cinco')).toBeNull();
    // A página da PGFN imprime os coeficientes com ponto: "5(0.3V1 + 0.1V2 + V3)".
    expect(lerNumero('0.3')).toBe(0.3);
    expect(lerNumero('0.80')).toBe(0.8);
    expect(lerNumero('1.234,5')).toBeNull();
  });

  it('normaliza espaço, quebra de linha e NBSP', () => {
    expect(normalizar('R$ 950.000,00\n  C')).toBe('R$ 950.000,00 C');
  });
});

describe('conferirExtracao', () => {
  it('trechos no documento e conta que chega à CAPAG impressa: conferida', () => {
    const r = conferirExtracao(extracaoDoDemonstrativo(), DEMONSTRATIVO_TEXTO);

    expect(r.problems).toEqual([]);
    expect(r.valuesCents).toEqual({ V1: 100_000_000, V7: 20_000_000, V8: 5_000_000 });
    expect(r.computedCapagCents).toBe(95_000_000);
    expect(r).toMatchObject({ reproduces: true, verified: true, band: 'C', referenceDate: '2026-08-01', totalDebtCents: 200_000_000 });
    expect(r.formula?.verified).toBe(true);
  });

  it('trecho que não está no documento: problema, e nada conferido', () => {
    const e = extracaoDoDemonstrativo();
    e.values[0]!.amount.quote = 'V1 - Receita bruta: R$ 1.000.000,00';

    const r = conferirExtracao(e, DEMONSTRATIVO_TEXTO);

    expect(r.verified).toBe(false);
    expect(r.problems[0]).toMatch(/Valor de V1: o trecho citado não está no documento/);
  });

  /** O modelo transcreve 10 vezes mais: o trecho existe, mas não contém o número. */
  it('número que não está no trecho citado é recusado', () => {
    const e = extracaoDoDemonstrativo();
    e.values[0]!.amount.printed = 'R$ 10.000.000,00';

    const r = conferirExtracao(e, DEMONSTRATIVO_TEXTO);

    expect(r.problems).toContainEqual(expect.stringMatching(/"R\$ 10\.000\.000,00" não está no trecho/));
    expect(r.verified).toBe(false);
  });

  it('conta que não chega à CAPAG impressa: não reproduz, com os dois valores', () => {
    const texto = DEMONSTRATIVO_TEXTO.replace('presumida: R$ 950.000,00', 'presumida: R$ 990.000,00');
    const e = extracaoDoDemonstrativo();
    e.capag = { printed: 'R$ 990.000,00', quote: 'Capacidade de pagamento presumida: R$ 990.000,00' };

    const r = conferirExtracao(e, texto);

    expect(r.reproduces).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.problems[0]).toMatch(/dão R\$ 950\.000,00, e o demonstrativo diz R\$ 990\.000,00/);
  });

  it('doutrina nunca é conferida, mesmo com todos os trechos certos', () => {
    const e = { ...extracaoDoDemonstrativo(), documentKind: 'norma_ou_doutrina' as const, values: [], capag: null, totalDebt: null, band: null };

    const r = conferirExtracao(e, DEMONSTRATIVO_TEXTO);

    expect(r.problems).toEqual([]);
    expect(r.formula?.terms).toHaveLength(3);
    expect(r.verified).toBe(false);
    expect(r.formula?.verified).toBe(false);
  });

  it('faixa fora do trecho citado é recusada', () => {
    const e = extracaoDoDemonstrativo();
    e.band = { value: 'A', quote: 'Classificação: C' };

    expect(conferirExtracao(e, DEMONSTRATIVO_TEXTO).problems).toContainEqual(expect.stringMatching(/faixa "A"/));
  });
});

describe('lerExtracao', () => {
  it('recusa o que não é JSON e o JSON sem os campos', () => {
    expect(() => lerExtracao('não sei')).toThrow(/não é JSON/);
    expect(() => lerExtracao('{"documentKind":"outro"}')).toThrow(/campos combinados/);
  });

  it('aceita a extração no formato combinado', () => {
    expect(lerExtracao(JSON.stringify(extracaoDoDemonstrativo())).group).toBe('pj_nao_simples');
  });
});
