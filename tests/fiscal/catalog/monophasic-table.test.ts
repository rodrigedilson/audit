import { describe, it, expect } from 'vitest';
import {
  dataIso,
  expandir,
  extrairCelulas,
  grupoMonofasico,
  interpretarNcm,
  lerRegistros,
  periodoVigente,
} from '../../../src/fiscal/catalog/monophasic-table.js';

/** Células como saem do `.doc`: cada uma termina em `\x07`. */
function doc(...celulas: string[]): Uint8Array {
  const texto = ['Tabela 4.3.10 - Produtos Sujeitos a Alíquotas Diferenciadas', ...celulas].join('\x07');
  const bytes = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i += 1) {
    // Windows-1252 coincide com Latin-1 nos caracteres usados aqui.
    bytes[i] = texto.charCodeAt(i) & 0xff;
  }
  return bytes;
}

describe('extrairCelulas', () => {
  it('separa pelas marcas de célula do Word', () => {
    expect(extrairCelulas(doc('101', 'Gasolinas', '2710.12.59'))).toEqual([
      'Tabela 4.3.10 - Produtos Sujeitos a Alíquotas Diferenciadas',
      '101',
      'Gasolinas',
      '2710.12.59',
    ]);
  });

  it('sem o título da tabela, falha em vez de ler lixo', () => {
    expect(() => extrairCelulas(new TextEncoder().encode('outro documento'))).toThrow(/Tabela 4\.3\.10/);
  });
});

describe('lerRegistros', () => {
  it('lê NCM e períodos pelo formato das células, sem depender do fim de linha', () => {
    const [r] = lerRegistros(
      extrairCelulas(doc('101', 'Gasolinas', '2710.11.59', '5,08', '23,44', '01/2011', '31/12/2011')),
    );

    expect(r).toEqual({
      codigo: '101',
      descricao: 'Gasolinas',
      ncm: ['2710.11.59'],
      periodos: [{ pis: 5.08, cofins: 23.44, inicio: '2011-01-01', termino: '2011-12-31' }],
    });
  });

  it('lê vários períodos, e o último em aberto', () => {
    const [r] = lerRegistros(
      extrairCelulas(
        doc('415', 'Águas', '22.01', '1,67', '7.69', '01/01/2017', '31/12/2017', '1,86', '8,54', '01/01/2018'),
      ),
    );

    expect(r!.periodos).toHaveLength(2);
    expect(r!.periodos[1]).toEqual({ pis: 1.86, cofins: 8.54, inicio: '2018-01-01', termino: null });
  });

  // `22.03` passava por alíquota de 22,03% e tirava a cerveja da tabela.
  it('a posição 22.03 é NCM, não alíquota', () => {
    const [r] = lerRegistros(extrairCelulas(doc('423', 'Cervejas de malte', '22.03', '1,86', '8,54', '01/01/2018')));

    expect(r!.ncm).toEqual(['22.03']);
    expect(r!.periodos).toHaveLength(1);
  });
});

describe('dataIso e periodoVigente', () => {
  it('mês/ano é o dia 1 no início e o último dia no fim', () => {
    expect(dataIso('02/2024', 'inicio')).toBe('2024-02-01');
    expect(dataIso('02/2024', 'fim')).toBe('2024-02-29');
    expect(dataIso('30/04/2015', 'fim')).toBe('2015-04-30');
  });

  it('só o período que contém a data vale', () => {
    const registro = {
      codigo: '400',
      descricao: '',
      ncm: [],
      periodos: [{ pis: 1, cofins: 1, inicio: '2011-01-01', termino: '2015-04-30' }],
    };

    expect(periodoVigente(registro, '2014-06-01')).toBeDefined();
    expect(periodoVigente(registro, '2026-09-24')).toBeUndefined();
  });
});

describe('grupoMonofasico', () => {
  it.each([
    ['101', 'combustiveis'],
    ['117', 'combustiveis'],
    ['201', 'farmacos'],
    ['202', 'perfumaria'],
    ['302', 'autopecas'],
    ['304', 'pneus'],
    ['427', 'bebidas_frias'],
  ])('%s é %s', (codigo, grupo) => {
    expect(grupoMonofasico(codigo)).toBe(grupo);
  });

  // Revenda descreve a operação, não o produto; nafta é alíquota reduzida.
  it.each(['001', '199', '299', '399', '499', '150', '153'])('%s não é monofásico', (codigo) => {
    expect(grupoMonofasico(codigo)).toBeNull();
  });
});

describe('interpretarNcm', () => {
  it('lê posições, itens e códigos em qualquer grafia', () => {
    const r = interpretarNcm(['84.29, 8433.5, 84.32.80.00 e 2207.20.1']);

    expect(r.inclusoes.map((i) => i.prefixo)).toEqual(['8429', '84335', '84328000', '2207201']);
  });

  it('"exceto no código" tira o código da posição', () => {
    const r = interpretarNcm(['30.03 (exceto no código 3003.90.56), 30.04 (exceto no código 3004.90.46)']);

    expect(r.inclusoes.map((i) => i.prefixo)).toEqual(['3003', '3004']);
    expect(r.exclusoes).toEqual(['30039056', '30049046']);
  });

  it('"exceto os Ex do código" é ressalva, não exclusão', () => {
    const r = interpretarNcm(['22.01, exceto os Ex 01 e Ex 02 do código 22.01.10.00']);

    expect(r.exclusoes).toEqual([]);
    expect(r.inclusoes).toContainEqual({ prefixo: '22011000', excetoEx: ['01', '02'] });
  });

  it('"(exceto 3401.11.90 Ex 01)" é ressalva do próprio código', () => {
    const r = interpretarNcm(['3401.11.90 (exceto 3401.11.90 Ex 01), 3401.20.10']);

    expect(r.inclusoes).toContainEqual({ prefixo: '34011190', excetoEx: ['01'] });
    expect(r.exclusoes).toEqual([]);
  });

  it('código seguido de Ex é só aquele ex-tarifário', () => {
    expect(interpretarNcm(['2208.90.00 Ex 01']).inclusoes).toEqual([
      { prefixo: '22089000', somenteEx: ['01'] },
    ]);
  });

  // O "22" de "e 22.03" era lido como mais um ex-tarifário.
  it('"Ex 03 e 22.03" são duas coisas: o ex e outra posição', () => {
    expect(interpretarNcm(['22.02.90.00 Ex 03 e 22.03']).inclusoes).toEqual([
      { prefixo: '22029000', somenteEx: ['03'] },
      { prefixo: '2203' },
    ]);
  });

  it('o mesmo código também sem Ex é o código inteiro', () => {
    expect(interpretarNcm(['3826.00.00', '3826.00.00Ex 01']).inclusoes).toEqual([{ prefixo: '38260000' }]);
  });

  it('faixa vira as posições intermediárias', () => {
    expect(interpretarNcm(['33.03 a 33.07']).inclusoes.map((i) => i.prefixo)).toEqual([
      '3303',
      '3304',
      '3305',
      '3306',
      '3307',
    ]);
  });

  // `01` de `Ex 01` e `13.09` de `Lei nº 13.097` não são NCM.
  it('não lê ex-tarifário nem número de lei como posição', () => {
    const r = interpretarNcm(['2208.90.00 Ex 01, conforme a Lei nº 13.097']);

    expect(r.inclusoes.map((i) => i.prefixo)).toEqual(['22089000']);
  });

  it('remissão sem código volta como remissão', () => {
    expect(interpretarNcm(['Anexos I e II da Lei nº 10.485/02'])).toEqual({
      inclusoes: [],
      exclusoes: [],
      remissao: 'Anexos I e II da Lei nº 10.485/02',
    });
  });
});

describe('expandir', () => {
  const OFICIAIS = ['30039056', '30039099', '30049045', '30049046', '22089000', '22011000'];

  it('prefixo vira os NCMs oficiais abaixo dele, menos os excluídos', () => {
    const { ncms } = expandir(
      { inclusoes: [{ prefixo: '3003' }, { prefixo: '3004' }], exclusoes: ['30039056', '30049046'], remissao: null },
      OFICIAIS,
    );

    expect([...ncms.keys()]).toEqual(['30039099', '30049045']);
  });

  it('a ressalva de ex-tarifário acompanha o NCM', () => {
    const { ncms } = expandir(
      {
        inclusoes: [
          { prefixo: '22089000', somenteEx: ['01'] },
          { prefixo: '22011000', excetoEx: ['01', '02'] },
        ],
        exclusoes: [],
        remissao: null,
      },
      OFICIAIS,
    );

    expect(ncms.get('22089000')).toBe('somente Ex 01');
    expect(ncms.get('22011000')).toBe('exceto Ex 01, 02');
  });

  // Código que a nomenclatura desdobrou não é trocado pelo sucessor.
  it('prefixo sem NCM oficial é relatado, não inventado', () => {
    const r = expandir({ inclusoes: [{ prefixo: '3002101' }], exclusoes: [], remissao: null }, OFICIAIS);

    expect(r.ncms.size).toBe(0);
    expect(r.semCorrespondencia).toEqual(['3002101']);
  });
});
