import { describe, it, expect } from 'vitest';
import {
  lerAnexosLei10485,
  montarFlags,
  textoDoHtml,
} from '../../../src/fiscal/catalog/monophasic-flags.js';
import type { Periodo, Registro } from '../../../src/fiscal/catalog/monophasic-table.js';

/** Trecho no formato do texto compilado do Planalto. */
const LEI = textoDoHtml(`
  <p>ANEXO I</p>
  <p>CÓDIGO</p><p>4016.10.10</p><p>4016.99.90 Ex</p><p>03 e 05</p>
  <p>8536.50.90 Ex 01</p>
  <p>(Redação dada pelo Decreto nº 4.542, de 2002 e nº 6.006, de 2006 )</p>
  <p>(Vide art. 3º §1)</p>
  <p>87.08</p>
  <p>ANEXO II</p>
  <p>1. Tubos de borracha vulcanizada não endurecida da posição 40.09, com acessórios,
  próprias para máquinas e veículos autopropulsados das posições 84.29, 87.01;</p>
  <p>2. Partes da posição 84.31, reconhecíveis como destinadas às máquinas das posições 84.29;</p>
  <p>*</p><p>Este texto não substitui o publicado no DOU.</p>
`);

const OFICIAIS = [
  '40091100',
  '40161010',
  '40169990',
  '84295100',
  '84314100',
  '85365090',
  '87081000',
  '20029090',
  '30049045',
];

describe('lerAnexosLei10485', () => {
  it('lê o Anexo I com os ex-tarifários, e sem as notas de redação', () => {
    const { anexoI } = lerAnexosLei10485(LEI);

    expect(anexoI.inclusoes).toEqual([
      { prefixo: '40161010' },
      { prefixo: '40169990', somenteEx: ['03', '05'] },
      { prefixo: '85365090', somenteEx: ['01'] },
      { prefixo: '8708' },
    ]);
  });

  // O ano da nota "de 2002" passaria pela posição 20.02, que é tomate.
  it('o ano da nota de redação não vira NCM', () => {
    const { anexoI } = lerAnexosLei10485(LEI);

    expect(anexoI.inclusoes.map((i) => i.prefixo)).not.toContain('2002');
  });

  it('no Anexo II, o produto é o primeiro código do item; os outros são o destino', () => {
    const { anexoII } = lerAnexosLei10485(LEI);

    expect(anexoII.map((i) => [i.item, i.produto.prefixo])).toEqual([
      [1, '4009'],
      [2, '8431'],
    ]);
  });

  it('sem os anexos, falha', () => {
    expect(() => lerAnexosLei10485('Lei sem anexo')).toThrow(/Anexos I e II/);
  });
});

describe('montarFlags', () => {
  const vigente: Periodo = { pis: 2.1, cofins: 9.9, inicio: '2011-01-01', termino: null };
  const registro = (codigo: string, ncm: string[], periodos: Periodo[] = [vigente]): Registro => ({
    codigo,
    descricao: '',
    ncm,
    periodos,
  });

  it('marca os NCMs dos registros monofásicos vigentes, com a fonte na nota', () => {
    const m = montarFlags([registro('201', ['30.04'])], null, OFICIAIS, '2026-09-24', 'Tabela 4.3.10 v1.25');

    expect(m.linhas).toEqual([
      {
        ncm: '30049045',
        validFrom: '2011-01-01',
        note: 'Tabela 4.3.10 v1.25 · código 201, produtos farmacêuticos',
      },
    ]);
  });

  // `ncm_flags` não tem término: o que acabou não pode ficar marcado.
  it('registro encerrado não marca', () => {
    const encerrado: Periodo = { pis: 1, cofins: 1, inicio: '2011-01-01', termino: '2015-04-30' };
    const m = montarFlags([registro('401', ['40.09'], [encerrado])], null, OFICIAIS, '2026-09-24', 'F');

    expect(m.linhas).toEqual([]);
  });

  it('revenda e alíquota reduzida não marcam', () => {
    const m = montarFlags(
      [registro('199', ['30.04']), registro('150', ['30.04'])],
      null,
      OFICIAIS,
      '2026-09-24',
      'F',
    );

    expect(m.linhas).toEqual([]);
  });

  it('autopeças saem dos anexos da lei, com a condição do Anexo II na nota', () => {
    const m = montarFlags(
      [registro('302', ['Anexos I e II da Lei nº 10.485/02'])],
      lerAnexosLei10485(LEI),
      OFICIAIS,
      '2026-09-24',
      'F',
    );
    const nota = (ncm: string) => m.linhas.find((l) => l.ncm === ncm)?.note;

    expect(nota('40161010')).toBe('F · código 302, autopeças · Lei nº 10.485/2002, Anexo I');
    expect(nota('40169990')).toMatch(/somente Ex 03, 05$/);
    expect(nota('40091100')).toMatch(/Anexo II, item 1: só com o destino que o item define$/);
    expect(nota('20029090')).toBeUndefined();
  });

  it('sem os anexos, a remissão é relatada em vez de ignorada', () => {
    const m = montarFlags([registro('302', ['Anexos I e II da Lei nº 10.485/02'])], null, OFICIAIS, '2026-09-24', 'F');

    expect(m.linhas).toEqual([]);
    expect(m.remissoesNaoLidas).toEqual([{ codigo: '302', texto: 'Anexos I e II da Lei nº 10.485/02' }]);
  });

  // 84.29 entra inteira pelos veículos (301) e condicionada pelo Anexo II.
  it('citação sem ressalva vence a ressalvada', () => {
    const m = montarFlags(
      [registro('301', ['84.31']), registro('302', ['Anexos I e II da Lei nº 10.485/02'])],
      lerAnexosLei10485(LEI),
      OFICIAIS,
      '2026-09-24',
      'F',
    );
    const nota = m.linhas.find((l) => l.ncm === '84314100')!.note;

    expect(nota).toContain('código 301');
    expect(nota).not.toContain('só com o destino');
  });

  it('o mesmo prefixo sem correspondência aparece uma vez', () => {
    const m = montarFlags(
      [registro('302', ['Anexos I e II da Lei nº 10.485/02']), registro('303', ['Anexos I e II da Lei nº 10.485/02'])],
      lerAnexosLei10485(LEI),
      ['40161010'],
      '2026-09-24',
      'F',
    );

    expect(m.semCorrespondencia.filter((s) => s.prefixo === '8708')).toHaveLength(1);
  });
});
