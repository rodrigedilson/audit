import { describe, it, expect } from 'vitest';
import {
  computeCheckDigit,
  isValidAccessKey,
  parseAccessKey,
  AccessKeyError,
} from '../../../src/fiscal/ingestion/access-key.js';

/** Monta uma chave válida a partir dos 43 primeiros dígitos. */
function withCheckDigit(first43: string): string {
  return first43 + computeCheckDigit(first43);
}

const BASE_43 = '3527081234567800019555001000000015123456789';

describe('computeCheckDigit', () => {
  it('produz um único dígito', () => {
    expect(computeCheckDigit(BASE_43)).toMatch(/^[0-9]$/);
  });

  it('é determinístico', () => {
    expect(computeCheckDigit(BASE_43)).toBe(computeCheckDigit(BASE_43));
  });

  it('muda quando qualquer dígito da chave muda', () => {
    const alterado = `9${BASE_43.slice(1)}`;

    expect(computeCheckDigit(alterado)).not.toBe(computeCheckDigit(BASE_43));
  });
});

describe('isValidAccessKey', () => {
  it('aceita chave com dígito verificador correto', () => {
    expect(isValidAccessKey(withCheckDigit(BASE_43))).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    const valida = withCheckDigit(BASE_43);
    const dvErrado = valida.slice(0, 43) + String((Number(valida[43]) + 1) % 10);

    expect(isValidAccessKey(dvErrado)).toBe(false);
  });

  it('recusa chave com tamanho diferente de 44', () => {
    expect(isValidAccessKey('123')).toBe(false);
    expect(isValidAccessKey(withCheckDigit(BASE_43) + '0')).toBe(false);
  });

  it('recusa chave com caractere não numérico', () => {
    expect(isValidAccessKey(`X${withCheckDigit(BASE_43).slice(1)}`)).toBe(false);
  });

  /**
   * É o filtro mais barato da ingestão: pega XML truncado ou chave digitada
   * errada antes de qualquer parse ou ida ao banco.
   */
  it('recusa chave com dois dígitos trocados de posição', () => {
    const valida = withCheckDigit(BASE_43);
    const trocada = valida.slice(0, 10) + valida[11] + valida[10] + valida.slice(12);

    expect(isValidAccessKey(trocada)).toBe(false);
  });
});

describe('parseAccessKey', () => {
  it('decompõe a chave nos seus campos', () => {
    const parts = parseAccessKey(withCheckDigit(BASE_43));

    expect(parts).toMatchObject({
      uf: '35',
      period: '2027-08',
      issuerCnpj: '12345678000195',
      model: '55',
      series: '001',
      number: '000000015',
    });
  });

  it('a competência sai da própria chave, no formato do contrato', () => {
    expect(parseAccessKey(withCheckDigit(BASE_43)).period).toMatch(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
  });

  it('recusa tamanho inválido explicando o tamanho recebido', () => {
    expect(() => parseAccessKey('123')).toThrow(/44 posições.*recebida .* com 3/);
  });

  it('recusa dígito verificador inválido dizendo o esperado', () => {
    const valida = withCheckDigit(BASE_43);
    const dvErrado = valida.slice(0, 43) + String((Number(valida[43]) + 1) % 10);

    expect(() => parseAccessKey(dvErrado)).toThrow(AccessKeyError);
    expect(() => parseAccessKey(dvErrado)).toThrow(/Dígito verificador/);
  });

  it('recusa mês de emissão fora de 01..12', () => {
    const mesInvalido = withCheckDigit(`3527131234567800019555001000000015123456789`);

    expect(() => parseAccessKey(mesInvalido)).toThrow(/Mês de emissão inválido/);
  });
});

/**
 * CNPJ alfanumérico na chave de acesso.
 *
 * A chave carrega o CNPJ do emitente nas posições 7 a 18, e desde 31/07/2026
 * esse CNPJ pode ter letras. A Nota Técnica Conjunta CNPJ Alfanumérico 2025.001
 * abriu a expressão regular da chave — `[0-9]{6}[A-Z0-9]{12}[0-9]{26}` — e
 * trocou o cálculo do DV para o valor ASCII menos 48 de cada caractere.
 */
describe('chave com CNPJ alfanumérico', () => {
  /** `12ABC34501DE` é o CNPJ do exemplo oficial do Serpro. */
  // A chave reserva 14 posições ao CNPJ: as 12 alfanuméricas e os 2 dígitos
  // verificadores dele, que continuam numéricos.
  const BASE_43_ALFA =
    '352708' + '12ABC34501DE35' + '55' + '001' + '000000015' + '1' + '23456789';

  it('aceita letras nas doze posições do CNPJ', () => {
    const chave = withCheckDigit(BASE_43_ALFA);

    expect(isValidAccessKey(chave)).toBe(true);
    expect(parseAccessKey(chave).issuerCnpj).toBe('12ABC34501DE35');
  });

  /**
   * A mudança não pode invalidar chave nenhuma já aceita: para caractere
   * numérico, ASCII menos 48 é o próprio dígito. Este teste fixa isso — se
   * alguém trocar o cálculo por outra coisa, dez anos de chave param de validar.
   */
  it('não muda o dígito de chave puramente numérica', () => {
    // O cálculo de antes, escrito aqui de propósito: comparar contra ele prova a
    // equivalência, enquanto uma constante só provaria que alguém a atualizou.
    const digitoPeloCalculoAntigo = (base: string): string => {
      let soma = 0;
      let peso = 2;
      for (let i = base.length - 1; i >= 0; i--) {
        soma += Number(base[i]) * peso;
        peso = peso === 9 ? 2 : peso + 1;
      }
      const resto = soma % 11;
      return resto <= 1 ? '0' : String(11 - resto);
    };

    expect(computeCheckDigit(BASE_43)).toBe(digitoPeloCalculoAntigo(BASE_43));
    expect(isValidAccessKey(withCheckDigit(BASE_43))).toBe(true);
  });

  it('recusa letra fora das posições do CNPJ', () => {
    const naUf = 'A5270812345678000195' + '55' + '001' + '000000015' + '1' + '23456789';

    expect(isValidAccessKey(withCheckDigit(naUf))).toBe(false);
  });

  /**
   * Minúscula tem outro código ASCII, e o DV calculado sobre ela não seria o da
   * chave impressa. Recusar é mais honesto do que normalizar aqui e devolver uma
   * chave diferente da que o arquivo trazia.
   */
  it('recusa minúscula', () => {
    expect(isValidAccessKey(withCheckDigit(BASE_43_ALFA).toLowerCase())).toBe(false);
  });

  it('o dígito verificador ainda muda quando a letra muda', () => {
    const outra = BASE_43_ALFA.replace('12ABC34501DE35', '12ABD34501DE35');

    expect(computeCheckDigit(outra)).not.toBe(computeCheckDigit(BASE_43_ALFA));
  });
});
