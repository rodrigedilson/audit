import { computeCheckDigit } from '../../src/fiscal/ingestion/access-key.js';

/**
 * Construtor de XML de NF-e para os testes.
 *
 * Existe porque cada suíte vinha repetindo o seu próprio `nfeXml`, cada uma com
 * um item fixo e um emitente fixo — o que serve para ingestão, mas não para
 * agregação, que precisa de vários emitentes, NCMs e competências no mesmo lote.
 */

/** Chave coerente: cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8). */
export function accessKey(issuer: string, numero = '000000015', model = '55'): string {
  const base = `35` + `2708` + issuer + model + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

export interface ItemOptions {
  ncm?: string;
  /** Valor do item em reais, como aparece no XML. */
  valor?: number;
  /** Quando `true`, o item traz o grupo UB (IBS/CBS) da NT 2025.002. */
  withReform?: boolean;
}

export interface NfeOptions {
  issuer: string;
  recipient: string;
  numero?: string;
  issuerName?: string;
  issuedAt?: string;
  /** Atalho: um único item, com ou sem grupo UB. */
  withReform?: boolean;
  items?: ItemOptions[];
}

function grupoReforma(valor: number): string {
  const ibs = (valor * 0.001).toFixed(2);
  const cbs = (valor * 0.0921).toFixed(2);
  return `<IBSCBS>
         <CST>000</CST><cClassTrib>000001</cClassTrib>
         <gIBSCBS>
           <vBC>${valor.toFixed(2)}</vBC>
           <gIBS>
             <gIBSUF><pIBSUF>0.10</pIBSUF><vIBSUF>${ibs}</vIBSUF></gIBSUF>
             <gIBSMun><pIBSMun>0.00</pIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun>
           </gIBS>
           <gCBS><pCBS>9.21</pCBS><vCBS>${cbs}</vCBS></gCBS>
         </gIBSCBS>
       </IBSCBS>`;
}

export function nfeXml(options: NfeOptions): string {
  const key = accessKey(options.issuer, options.numero ?? '000000015');
  const items = options.items ?? [{ withReform: options.withReform ?? false }];

  const total = items.reduce((soma, item) => soma + (item.valor ?? 1000), 0);

  const det = items
    .map((item, indice) => {
      const valor = item.valor ?? 1000;
      const icms = (valor * 0.18).toFixed(2);
      return `<det nItem="${indice + 1}">
    <prod><cProd>SKU-${indice + 1}</cProd><xProd>Produto ${indice + 1}</xProd>
      <NCM>${item.ncm ?? '73181500'}</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>${valor.toFixed(2)}</vUnCom><vProd>${valor.toFixed(2)}</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>${valor.toFixed(2)}</vBC><pICMS>18.00</pICMS><vICMS>${icms}</vICMS></ICMS00></ICMS>
      ${item.withReform ? grupoReforma(valor) : ''}
    </imposto>
  </det>`;
    })
    .join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>15</nNF><dhEmi>${options.issuedAt ?? '2027-08-15T10:30:00-03:00'}</dhEmi></ide>
  <emit><CNPJ>${options.issuer}</CNPJ><xNome>${options.issuerName ?? 'EMITENTE LTDA'}</xNome></emit>
  <dest><CNPJ>${options.recipient}</CNPJ><xNome>DESTINATARIO LTDA</xNome></dest>
  ${det}
  <total><ICMSTot><vNF>${total.toFixed(2)}</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}
