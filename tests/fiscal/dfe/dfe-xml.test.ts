import { describe, it, expect } from 'vitest';
import {
  cienciaRegistrada,
  dataHoraBrasilia,
  eventoVinculado,
  lerEventoNfe,
  envelopeDistribuicao,
  lerRespostaDistribuicao,
  lerRespostaEvento,
  lerResumoNfe,
  nsu,
  RespostaSefazInvalidaError,
} from '../../../src/fiscal/dfe/dfe-xml.js';
import { SefazSoapClient, type TransporteSoap } from '../../../src/fiscal/dfe/sefaz-gateway.js';
import { extrairCredencial, lerCredencial } from '../../../src/fiscal/portfolio/certificate-vault.js';
import { pfxDeTeste } from '../../helpers/certificado.js';
import { procEventoNFe, resEvento, respostaDistribuicao, respostaEvento, resNFe } from '../../helpers/sefaz.js';

const CHAVE = '35271112345678000195550010000000151234567890';

describe('distribuição — pedido', () => {
  it('monta o distDFeInt 1.01 por NSU, com zeros à esquerda', () => {
    const xml = envelopeDistribuicao({ tpAmb: 1, cUFAutor: '35', cnpj: '12345678000195', ultNsu: '123' });

    expect(xml).toContain('<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">');
    expect(xml).toContain('<tpAmb>1</tpAmb><cUFAutor>35</cUFAutor><CNPJ>12345678000195</CNPJ>');
    expect(xml).toContain('<distNSU><ultNSU>000000000000123</ultNSU></distNSU>');
    expect(xml).toContain('<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">');
  });

  it('nsu preserva os 15 dígitos', () => {
    expect(nsu('42')).toBe('000000000000042');
    expect(nsu('000000000000042')).toBe('000000000000042');
  });
});

describe('distribuição — resposta', () => {
  it('lê cStat, NSUs e descompacta cada documento pelo schema', () => {
    const r = lerRespostaDistribuicao(
      respostaDistribuicao('138', [
        { nsu: '000000000000011', schema: 'resNFe_v1.01.xsd', xml: resNFe(CHAVE) },
        { nsu: '000000000000012', schema: 'procNFe_v4.00.xsd', xml: '<nfeProc>completo</nfeProc>' },
        { nsu: '000000000000013', schema: 'resEvento_v1.01.xsd', xml: '<resEvento/>' },
      ]),
    );

    expect(r).toMatchObject({ cStat: '138', ultNsu: '000000000000010', maxNsu: '000000000000020' });
    expect(r.documentos.map((d) => [d.nsu, d.esquema])).toEqual([
      ['000000000000011', 'resNFe'],
      ['000000000000012', 'procNFe'],
      ['000000000000013', 'resEvento'],
    ]);
    expect(r.documentos[1]!.xml).toBe('<nfeProc>completo</nfeProc>');
  });

  it('um documento só também vira lista', () => {
    const r = lerRespostaDistribuicao(respostaDistribuicao('138', [{ nsu: '1', schema: 'resNFe_v1.01.xsd', xml: resNFe(CHAVE) }]));
    expect(r.documentos).toHaveLength(1);
  });

  it('137 sem lote não é erro: é "nada novo"', () => {
    expect(lerRespostaDistribuicao(respostaDistribuicao('137')).documentos).toEqual([]);
  });

  it('SOAP sem retDistDFeInt é resposta inválida', () => {
    expect(() => lerRespostaDistribuicao('<Envelope><Body><Fault/></Body></Envelope>')).toThrow(RespostaSefazInvalidaError);
  });

  /** CNPJ alfanumérico (NT Conjunta 2025.001): letras só nas 12 posições do emitente. */
  it('aceita chave com CNPJ alfanumérico, e recusa letra fora do CNPJ', () => {
    const alfanumerica = '352711AB12CD34EF5655001000000015123456789012';
    expect(lerResumoNfe(resNFe(alfanumerica)).accessKey).toBe(alfanumerica);
    expect(() => lerResumoNfe(resNFe('A' + alfanumerica.slice(1)))).toThrow(RespostaSefazInvalidaError);
  });

  it('o resumo traz chave, emitente, data e valor em centavos', () => {
    expect(lerResumoNfe(resNFe(CHAVE, '1500.35'))).toEqual({
      accessKey: CHAVE,
      issuerCnpj: '01234567000100',
      issuerName: 'FORNECEDOR LTDA',
      issuedAt: '2027-11-15T10:30:00-03:00',
      totalCents: 150035,
    });
  });
});

describe('evento — resposta', () => {
  it.each(['135', '136', '573'])('%s é ciência registrada', (c) => {
    expect(cienciaRegistrada(lerRespostaEvento(respostaEvento(c)).cStat)).toBe(true);
  });

  it('lote rejeitado inteiro devolve o motivo do lote', () => {
    const r = lerRespostaEvento(respostaEvento('', '215'));
    expect(r).toMatchObject({ cStatLote: '215', cStat: '215' });
    expect(cienciaRegistrada(r.cStat)).toBe(false);
  });

  it('dhEvento sai no horário de Brasília', () => {
    expect(dataHoraBrasilia(new Date('2027-11-20T13:00:00Z'))).toBe('2027-11-20T10:00:00-03:00');
  });
});

describe('SefazSoapClient', () => {
  const credencial = lerCredencial(extrairCredencial(pfxDeTeste({ password: 's' }), 's'));

  const transporte = (resposta: string) => {
    const chamadas: { url: string; acao: string; corpo: string }[] = [];
    const fn: TransporteSoap = async (url, acao, corpo) => {
      chamadas.push({ url, acao, corpo });
      return resposta;
    };
    return { fn, chamadas };
  };

  it('a distribuição vai ao endpoint de produção com a ação do WSDL', async () => {
    const t = transporte(respostaDistribuicao('137'));
    await new SefazSoapClient(t.fn).distribuir(credencial, { tpAmb: 1, cUFAutor: '35', cnpj: '12345678000195', ultNsu: '0' });

    expect(t.chamadas[0]!.url).toBe('https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');
    expect(t.chamadas[0]!.acao).toBe('http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse');
  });

  it('a ciência vai assinada, no envEvento, para o Ambiente Nacional', async () => {
    const t = transporte(respostaEvento('135'));
    const r = await new SefazSoapClient(t.fn).manifestarCiencia(credencial, {
      tpAmb: 1,
      cnpj: '12345678000195',
      accessKey: CHAVE,
      dhEvento: '2027-11-20T10:00:00-03:00',
    });

    expect(r.cStat).toBe('135');
    expect(t.chamadas[0]!.url).toBe('https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx');
    expect(t.chamadas[0]!.corpo).toMatch(/<envEvento xmlns="http:\/\/www.portalfiscal.inf.br\/nfe" versao="1.00"><idLote>\d{1,15}<\/idLote><evento /);
    expect(t.chamadas[0]!.corpo).toContain('<SignatureValue>');
  });
});

describe('distribuição — evento de NF-e', () => {
  it('lê o cancelamento completo: tipo, sequência, cStat e o protocolo do evento', () => {
    const e = lerEventoNfe(procEventoNFe(CHAVE));

    expect(e).toEqual({
      accessKey: CHAVE,
      tpEvento: '110111',
      nSeqEvento: 1,
      cStat: '135',
      // O do evento, e não o nProt da autorização que vem no detEvento.
      protocolo: '135270000009999',
      dhEvento: '2027-11-16T09:00:00-03:00',
    });
    expect(eventoVinculado(e)).toBe(true);
  });

  it('resEvento não traz cStat, e vale: só existe para evento registrado', () => {
    const e = lerEventoNfe(resEvento(CHAVE));

    expect(e).toMatchObject({ accessKey: CHAVE, tpEvento: '110111', cStat: null, protocolo: '135270000009998' });
    expect(eventoVinculado(e)).toBe(true);
  });

  it('155 (fora de prazo) vale; 136 (sem vínculo com a NF-e) não', () => {
    expect(eventoVinculado(lerEventoNfe(procEventoNFe(CHAVE, '155')))).toBe(true);
    expect(eventoVinculado(lerEventoNfe(procEventoNFe(CHAVE, '136')))).toBe(false);
  });

  it('evento sem chave válida é recusado', () => {
    expect(() => lerEventoNfe('<resEvento><chNFe>123</chNFe><tpEvento>110111</tpEvento></resEvento>')).toThrow(
      RespostaSefazInvalidaError,
    );
  });
});
