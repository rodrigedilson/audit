import { describe, it, expect } from 'vitest';
import { ReadinessReportCipher } from '../../../src/fiscal/ingestion/readiness-cipher.js';
import type { ReadinessReport } from '../../../src/fiscal/ingestion/readiness.js';

const RELATORIO = {
  totals: { documents: 1, parsed: 1, rejected: 0, duplicates: 0 },
  documentsReady: { total: 1, ready: 1, readyPct: 100 },
  itemsReady: { total: 1, ready: 1, readyPct: 100 },
  valueReady: { totalCents: 100, readyCents: 100, readyPct: 100 },
  periods: [],
  issuers: [{ cnpj: '11222333000181', name: 'FORNECEDOR LTDA', documents: { total: 1, ready: 1, readyPct: 100 }, totalCents: 100 }],
  issuersTruncated: false,
  ncms: [],
  ncmsTruncated: false,
  rejections: [],
} satisfies ReadinessReport;

describe('ReadinessReportCipher', () => {
  const chave = 'chave-do-relatorio-de-teste-com-mais-de-32';

  it('decifra o que cifrou, e o texto cifrado não carrega o CNPJ', () => {
    const cifra = new ReadinessReportCipher(chave);
    const guardado = cifra.encrypt(RELATORIO);

    expect(guardado).not.toContain('11222333000181');
    expect(cifra.decrypt(guardado)).toEqual(RELATORIO);
  });

  it('outra chave não abre', () => {
    const guardado = new ReadinessReportCipher(chave).encrypt(RELATORIO);
    expect(() => new ReadinessReportCipher(`${chave}-outra`).decrypt(guardado)).toThrow();
  });

  it('texto adulterado não abre (GCM autentica)', () => {
    const cifra = new ReadinessReportCipher(chave);
    const [iv, tag, dados] = cifra.encrypt(RELATORIO).split(':');
    const adulterado = Buffer.from(dados!, 'base64');
    adulterado[0] = adulterado[0]! ^ 1;
    expect(() => cifra.decrypt([iv, tag, adulterado.toString('base64')].join(':'))).toThrow();
  });
});
