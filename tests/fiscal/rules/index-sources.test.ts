import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IndexSourceError,
  conferirFontes,
  lerSgs,
  lerSidra,
  urlDaFonte,
} from '../../../src/fiscal/rules/index-sources.js';

const fixture = (nome: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/indices', nome), 'utf8'));

/** 25/09/2026, meio-dia em Brasília: setembro/2026 ainda não fechou. */
const AGORA = new Date('2026-09-25T15:00:00Z');

describe('lerSgs', () => {
  it('lê a resposta real do BCB: percentual em fração, competência AAAA-MM', () => {
    const pontos = lerSgs(fixture('sgs-433-2025.json'), AGORA);

    expect(pontos).toHaveLength(12);
    expect(pontos[0]).toEqual({ period: '2025-01', variation: 0.0016 });
    expect(pontos[1]).toEqual({ period: '2025-02', variation: 0.0131 });
    // Negativo continua negativo: deflação é variação, não ausência.
    expect(pontos.find((p) => p.period === '2025-08')?.variation).toBe(-0.0011);
  });

  /** A 4390 traz setembro/2026 acumulado até ontem, e fora de ordem. */
  it('descarta a competência que não fechou e ordena', () => {
    const pontos = lerSgs(fixture('sgs-4390-ultimos.json'), AGORA);

    expect(pontos.map((p) => p.period)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('não produz 0.0007000000000000001', () => {
    expect(lerSgs([{ data: '01/07/2026', valor: '0.07' }], AGORA)[0]!.variation).toBe(0.0007);
  });

  it('recusa valor não numérico e competência repetida', () => {
    expect(() => lerSgs([{ data: '01/01/2025', valor: 'n/d' }], AGORA)).toThrow(IndexSourceError);
    expect(() =>
      lerSgs(
        [
          { data: '01/01/2025', valor: '0.1' },
          { data: '15/01/2025', valor: '0.2' },
        ],
        AGORA,
      ),
    ).toThrow(/duas vezes/);
  });

  it('recusa o que não é lista (a página HTML de erro que o SGS às vezes devolve)', () => {
    expect(() => lerSgs('<html>Requisição inválida!</html>', AGORA)).toThrow(IndexSourceError);
  });
});

describe('lerSidra', () => {
  it('pula o cabeçalho e lê a resposta real do IBGE', () => {
    const pontos = lerSidra(fixture('sidra-1737-2025.json'), AGORA);

    expect(pontos).toHaveLength(12);
    expect(pontos[0]).toEqual({ period: '2025-01', variation: 0.0016 });
  });

  it('só o cabeçalho é série vazia; "..." é mês sem dado', () => {
    const cabecalho = { D3C: 'Mês (Código)', V: 'Valor' };
    expect(lerSidra([cabecalho], AGORA)).toEqual([]);
    expect(lerSidra([cabecalho, { D3C: '202501', V: '...' }, { D3C: '202502', V: '1.31' }], AGORA)).toEqual([
      { period: '2025-02', variation: 0.0131 },
    ]);
  });
});

describe('conferirFontes', () => {
  it('IBGE e BCB batem no IPCA de 2025 (respostas reais)', () => {
    const r = conferirFontes(lerSidra(fixture('sidra-1737-2025.json'), AGORA), lerSgs(fixture('sgs-433-2025.json'), AGORA));

    expect(r).toEqual({ compared: 12, divergences: [] });
  });

  it('aponta o mês em que as fontes divergem', () => {
    const r = conferirFontes(
      [
        { period: '2025-01', variation: 0.0016 },
        { period: '2025-02', variation: 0.0131 },
      ],
      [
        { period: '2025-01', variation: 0.0016 },
        { period: '2025-02', variation: 0.0132 },
      ],
    );

    expect(r.divergences).toEqual([{ period: '2025-02', primary: 0.0131, crossCheck: 0.0132 }]);
  });
});

describe('urlDaFonte', () => {
  it('monta o SIDRA e o SGS com o último dia do mês final', () => {
    expect(urlDaFonte({ kind: 'sidra', code: 't1737/v63' }, '2025-01', '2025-12')).toBe(
      'https://apisidra.ibge.gov.br/values/t/1737/n1/all/v/63/p/202501-202512?formato=json',
    );
    expect(urlDaFonte({ kind: 'sgs', code: '4390' }, '2024-01', '2024-02')).toBe(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.4390/dados?formato=json&dataInicial=01/01/2024&dataFinal=29/02/2024',
    );
  });
});
