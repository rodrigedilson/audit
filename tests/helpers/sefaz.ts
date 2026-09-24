import { gzipSync } from 'node:zlib';

/** Chave de acesso usada nas respostas de evento. */
const CHAVE = '35271112345678000195550010000000151234567890';

/** O que a SEFAZ devolve: SOAP 1.2, com os documentos em GZip e base64. */
export function respostaDistribuicao(
  cStat: string,
  docs: { nsu: string; schema: string; xml: string }[] = [],
  ult = '000000000000010',
  max = '000000000000020',
): string {
  const zips = docs
    .map((d) => `<docZip NSU="${d.nsu}" schema="${d.schema}">${gzipSync(Buffer.from(d.xml)).toString('base64')}</docZip>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>' +
    '<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>' +
    `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.5.11</verAplic>` +
    `<cStat>${cStat}</cStat><xMotivo>motivo ${cStat}</xMotivo><dhResp>2027-11-20T10:00:00-03:00</dhResp>` +
    `<ultNSU>${ult}</ultNSU><maxNSU>${max}</maxNSU>` +
    (zips === '' ? '' : `<loteDistDFeInt>${zips}</loteDistDFeInt>`) +
    '</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>'
  );
}

export function resNFe(chave: string, vNF = '1500.00'): string {
  return (
    `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>${chave}</chNFe>` +
    '<CNPJ>01234567000100</CNPJ><xNome>FORNECEDOR LTDA</xNome><IE>123</IE>' +
    `<dhEmi>2027-11-15T10:30:00-03:00</dhEmi><tpNF>1</tpNF><vNF>${vNF}</vNF><digVal>x</digVal>` +
    '<dhRecbto>2027-11-15T10:31:00-03:00</dhRecbto><nProt>135270000000001</nProt><cSitNFe>1</cSitNFe></resNFe>'
  );
}

export function respostaEvento(cStat: string, cStatLote = '128'): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>' +
    '<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">' +
    `<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote><tpAmb>1</tpAmb>` +
    `<cStat>${cStatLote}</cStat><xMotivo>Lote de evento processado</xMotivo>` +
    (cStatLote === '128'
      ? `<retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><cStat>${cStat}</cStat><xMotivo>evento ${cStat}</xMotivo>` +
        `<chNFe>${CHAVE}</chNFe><nProt>891270000000001</nProt></infEvento></retEvento>`
      : '') +
    '</retEnvEvento></nfeResultMsg></soap:Body></soap:Envelope>'
  );
}

