import { describe, it, expect } from 'vitest';
import {
  documentoValido,
  mesDeReferencia,
  primeiroVencimento,
} from '../../src/billing/billing-schedule.js';

describe('mesDeReferencia — pós-pago', () => {
  it('a fatura que vence em novembro cobra outubro', () => {
    expect(mesDeReferencia('2026-11-10')).toBe('2026-10');
  });

  it('a que vence em janeiro cobra dezembro do ano anterior', () => {
    expect(mesDeReferencia('2027-01-10')).toBe('2026-12');
  });
});

describe('primeiroVencimento', () => {
  /**
   * Trial até 15 de outubro: outubro tem dias de trial, então o primeiro mês
   * cheio pago é novembro, que vence em 10 de dezembro.
   */
  it('trial ainda correndo: primeiro mês cheio depois do trial', () => {
    expect(primeiroVencimento('2026-10-15', '2026-09-24')).toBe('2026-12-10');
  });

  it('trial já encerrado: primeiro mês cheio depois da ativação', () => {
    expect(primeiroVencimento('2026-08-01', '2026-09-24')).toBe('2026-11-10');
  });

  it('sem trial registrado, conta da ativação', () => {
    expect(primeiroVencimento(null, '2026-09-24')).toBe('2026-11-10');
  });

  it('atravessa o ano', () => {
    expect(primeiroVencimento('2026-11-20', '2026-11-01')).toBe('2027-01-10');
    expect(primeiroVencimento('2026-12-05', '2026-12-01')).toBe('2027-02-10');
  });

  it('a referência do primeiro vencimento nunca é um mês com dia de trial', () => {
    const vencimento = primeiroVencimento('2026-10-15', '2026-09-24');
    expect(mesDeReferencia(vencimento) > '2026-10').toBe(true);
  });
});

describe('documentoValido', () => {
  it.each(['52998224725', '11222333000181'])('%s é válido', (doc) => {
    expect(documentoValido(doc)).toBe(true);
  });

  it.each([
    ['52998224724', 'dígito verificador errado'],
    ['11222333000182', 'dígito verificador errado'],
    ['11111111111', 'dígitos repetidos'],
    ['00000000000000', 'dígitos repetidos'],
    ['1122233300018', '13 dígitos'],
    ['112.223.330-00', 'com máscara (quem chama tira antes)'],
  ])('%s é inválido (%s)', (doc) => {
    expect(documentoValido(doc)).toBe(false);
  });
});
