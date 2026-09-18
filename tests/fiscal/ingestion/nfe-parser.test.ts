import { describe, it, expect } from 'vitest';
import { parseNfe, DocumentParseError } from '../../../src/fiscal/ingestion/nfe-parser.js';
import { computeCheckDigit } from '../../../src/fiscal/ingestion/access-key.js';

const ISSUER = '12345678000195';
const RECIPIENT = '98765432000110';

/**
 * Chave coerente com o emitente: o parser cruza os dois.
 *
 * Layout dos 43 dígitos antes do DV: cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3)
 * nNF(9) tpEmis(1) cNF(8).
 */
function accessKey(issuer = ISSUER, model = '55'): string {
  const base = `35` + `2708` + issuer + model + '001' + '000000015' + '1' + '23456789';
  if (base.length !== 43) {
    throw new Error(`chave de teste malformada: ${base.length} dígitos, esperados 43`);
  }
  return base + computeCheckDigit(base);
}

interface NfeOptions {
  key?: string;
  issuerCnpj?: string;
  items?: string;
  issuedAt?: string;
  omitIde?: boolean;
}

function nfeXml(options: NfeOptions = {}): string {
  const key = options.key ?? accessKey(options.issuerCnpj ?? ISSUER);
  const items = options.items ?? itemLegacy(1);

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${key}" versao="4.00">
      ${options.omitIde ? '' : `<ide>
        <serie>001</serie>
        <nNF>15</nNF>
        <dhEmi>${options.issuedAt ?? '2027-08-15T10:30:00-03:00'}</dhEmi>
      </ide>`}
      <emit>
        <CNPJ>${options.issuerCnpj ?? ISSUER}</CNPJ>
        <xNome>INDUSTRIA EXEMPLO LTDA</xNome>
      </emit>
      <dest>
        <CNPJ>${RECIPIENT}</CNPJ>
        <xNome>COMERCIO DESTINO LTDA</xNome>
      </dest>
      ${items}
      <total>
        <ICMSTot><vNF>1099.00</vNF></ICMSTot>
      </total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

function itemLegacy(line: number): string {
  return `<det nItem="${line}">
    <prod>
      <cProd>SKU-001</cProd>
      <xProd>Parafuso sextavado M8</xProd>
      <NCM>73181500</NCM>
      <CFOP>5102</CFOP>
      <uCom>UN</uCom>
      <qCom>100.0000</qCom>
      <vUnCom>10.99</vUnCom>
      <vProd>1099.00</vProd>
    </prod>
    <imposto>
      <ICMS><ICMS00>
        <CST>00</CST><vBC>1099.00</vBC><pICMS>18.00</pICMS><vICMS>197.82</vICMS>
      </ICMS00></ICMS>
      <IPI><IPITrib>
        <CST>50</CST><vBC>1099.00</vBC><pIPI>5.00</pIPI><vIPI>54.95</vIPI>
      </IPITrib></IPI>
      <PIS><PISAliq>
        <CST>01</CST><vBC>1099.00</vBC><pPIS>1.65</pPIS><vPIS>18.13</vPIS>
      </PISAliq></PIS>
      <COFINS><COFINSAliq>
        <CST>01</CST><vBC>1099.00</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>83.52</vCOFINS>
      </COFINSAliq></COFINS>
    </imposto>
  </det>`;
}

/** Item com o grupo UB da NT 2025.002 ao lado dos tributos atuais. */
function itemWithReform(line: number): string {
  return `<det nItem="${line}">
    <prod>
      <cProd>SKU-002</cProd>
      <xProd>Servico de manutencao</xProd>
      <NCM>00000000</NCM>
      <CFOP>5933</CFOP>
      <uCom>UN</uCom>
      <qCom>1.0000</qCom>
      <vUnCom>1000.00</vUnCom>
      <vProd>1000.00</vProd>
    </prod>
    <imposto>
      <ICMS><ICMS00>
        <CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS>
      </ICMS00></ICMS>
      <IBSCBS>
        <CST>000</CST>
        <cClassTrib>000001</cClassTrib>
        <gIBSCBS>
          <vBC>1000.00</vBC>
          <gIBS>
            <gIBSUF><pIBSUF>0.10</pIBSUF><vIBSUF>1.00</vIBSUF></gIBSUF>
            <gIBSMun><pIBSMun>0.00</pIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun>
          </gIBS>
          <gCBS><pCBS>9.21</pCBS><vCBS>92.10</vCBS></gCBS>
        </gIBSCBS>
      </IBSCBS>
    </imposto>
  </det>`;
}

describe('parseNfe — cabeçalho', () => {
  it('extrai chave, modelo, série, número e emitente', () => {
    const doc = parseNfe(nfeXml());

    expect(doc.accessKey).toBe(accessKey());
    expect(doc.model).toBe('nfe');
    expect(doc.series).toBe('001');
    expect(doc.number).toBe('15');
    expect(doc.issuerCnpj).toBe(ISSUER);
    expect(doc.issuerName).toBe('INDUSTRIA EXEMPLO LTDA');
  });

  it('extrai o destinatário', () => {
    const doc = parseNfe(nfeXml());

    expect(doc.recipientCnpj).toBe(RECIPIENT);
    expect(doc.recipientName).toBe('COMERCIO DESTINO LTDA');
  });

  /** A competência sai da data de emissão, não da chave: é ela que rege a apuração. */
  it('deriva a competência da data de emissão', () => {
    const doc = parseNfe(nfeXml({ issuedAt: '2027-03-05T08:00:00-03:00' }));

    expect(doc.period).toBe('2027-03');
  });

  it('identifica NFC-e pelo modelo 65 da chave', () => {
    const doc = parseNfe(nfeXml({ key: accessKey(ISSUER, '65') }));

    expect(doc.model).toBe('nfce');
  });

  it('aceita XML sem o envelope nfeProc (nota apenas assinada)', () => {
    const comEnvelope = nfeXml();
    const semEnvelope = comEnvelope
      .replace('<nfeProc versao="4.00">', '')
      .replace('</nfeProc>', '');

    expect(parseNfe(semEnvelope).accessKey).toBe(accessKey());
  });

  it('converte valores para centavos inteiros', () => {
    const doc = parseNfe(nfeXml());

    // 1099.00 → 109900, sem 109899 por erro de ponto flutuante.
    expect(doc.totalCents).toBe(109_900);
    expect(Number.isInteger(doc.totalCents)).toBe(true);
  });
});

describe('parseNfe — tributos atuais', () => {
  it('lê ICMS, IPI, PIS e COFINS do mesmo item', () => {
    const [item] = parseNfe(nfeXml()).items;

    expect(item!.legacy.icms).toEqual({
      cst: '00',
      baseCents: 109_900,
      rate: 18,
      amountCents: 19_782,
    });
    expect(item!.legacy.ipi?.amountCents).toBe(5_495);
    expect(item!.legacy.pis?.rate).toBe(1.65);
    expect(item!.legacy.cofins?.amountCents).toBe(8_352);
  });

  it('lê dados do produto', () => {
    const [item] = parseNfe(nfeXml()).items;

    expect(item).toMatchObject({
      line: 1,
      code: 'SKU-001',
      ncm: '73181500',
      cfop: '5102',
      quantity: 100,
      unitPriceCents: 1_099,
      totalCents: 109_900,
    });
  });

  it('lê múltiplos itens', () => {
    const doc = parseNfe(nfeXml({ items: `${itemLegacy(1)}${itemLegacy(2)}` }));

    expect(doc.items).toHaveLength(2);
    expect(doc.items.map((i) => i.line)).toEqual([1, 2]);
  });

  /** CSOSN aparece no lugar do CST em nota do Simples. */
  it('lê CSOSN quando o item é do Simples', () => {
    const simples = nfeXml().replace(
      '<ICMS00>\n        <CST>00</CST><vBC>1099.00</vBC><pICMS>18.00</pICMS><vICMS>197.82</vICMS>\n      </ICMS00>',
      '<ICMSSN102><CSOSN>102</CSOSN><vBC>0.00</vBC><vICMS>0.00</vICMS></ICMSSN102>',
    );

    expect(parseNfe(simples).items[0]!.legacy.icms?.cst).toBe('102');
  });
});

describe('parseNfe — grupo UB (IBS/CBS)', () => {
  it('não inventa grupo de reforma em documento que não o traz', () => {
    const doc = parseNfe(nfeXml());

    expect(doc.hasReformGroup).toBe(false);
    expect(doc.items[0]!.reform).toBeUndefined();
  });

  /**
   * É o diferencial #2: os dois sistemas lidos do mesmo item, o que permite a
   * apuração dual velho/novo nota a nota.
   */
  it('lê CST-IBS/CBS, cClassTrib e os três tributos novos', () => {
    const doc = parseNfe(nfeXml({ items: itemWithReform(1) }));
    const reform = doc.items[0]!.reform;

    expect(doc.hasReformGroup).toBe(true);
    expect(reform).toMatchObject({ cst: '000', cclasstrib: '000001' });
    expect(reform?.cbs).toMatchObject({ rate: 9.21, amountCents: 9_210, baseCents: 100_000 });
    expect(reform?.ibsUf).toMatchObject({ rate: 0.1, amountCents: 100 });
    expect(reform?.ibsMun).toMatchObject({ rate: 0, amountCents: 0 });
  });

  it('lê os dois sistemas no mesmo item', () => {
    const item = parseNfe(nfeXml({ items: itemWithReform(1) })).items[0]!;

    expect(item.legacy.icms?.amountCents).toBe(18_000);
    expect(item.reform?.cbs?.amountCents).toBe(9_210);
  });

  it('marca hasReformGroup quando só parte dos itens tem o grupo', () => {
    const doc = parseNfe(nfeXml({ items: `${itemLegacy(1)}${itemWithReform(2)}` }));

    expect(doc.hasReformGroup).toBe(true);
    expect(doc.items[0]!.reform).toBeUndefined();
    expect(doc.items[1]!.reform).toBeDefined();
  });
});

describe('parseNfe — rejeições tipadas', () => {
  const expectRejection = (xml: string, layer: 1 | 2, pattern: RegExp) => {
    try {
      parseNfe(xml);
      throw new Error('deveria ter rejeitado');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentParseError);
      const failure = error as DocumentParseError;
      expect(failure.layer).toBe(layer);
      expect(failure.message).toMatch(pattern);
    }
  };

  it('camada 1: XML malformado, com a linha do erro', () => {
    expectRejection('<nfeProc><NFe><infNFe></nfeProc>', 1, /XML malformado na linha/);
  });

  it('camada 2: XML válido que não é NF-e', () => {
    expectRejection('<pedido><item>1</item></pedido>', 2, /não contém o grupo infNFe/);
  });

  it('camada 2: chave de acesso com dígito verificador inválido', () => {
    const key = accessKey();
    const invalida = key.slice(0, 43) + String((Number(key[43]) + 1) % 10);

    expectRejection(nfeXml({ key: invalida }), 2, /dígito verificador inválido/);
  });

  /** Chave de outra nota colada no arquivo, ou documento remontado. */
  it('camada 2: CNPJ do emitente divergente da chave', () => {
    const xml = nfeXml({ key: accessKey('11222333000181'), issuerCnpj: ISSUER });

    expectRejection(xml, 2, /não corresponde ao da chave de acesso/);
  });

  it('camada 2: documento sem data de emissão', () => {
    expectRejection(nfeXml({ omitIde: true }), 2, /sem data de emissão/);
  });

  it('camada 2: data de emissão inválida', () => {
    expectRejection(nfeXml({ issuedAt: '2027-99-99T00:00:00' }), 2, /Data de emissão inválida/);
  });

  it('camada 2: documento sem itens', () => {
    expectRejection(nfeXml({ items: '' }), 2, /sem itens/);
  });

  it('a rejeição carrega o motivo tipado, para virar output.rejected', () => {
    try {
      parseNfe('<pedido/>');
    } catch (error) {
      expect((error as DocumentParseError).reason).toBe('schema_violation');
    }
  });
});
