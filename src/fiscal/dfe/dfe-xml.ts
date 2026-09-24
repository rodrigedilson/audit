import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

/**
 * XML dos dois serviços do Ambiente Nacional usados pela coleta (ADR-006):
 * NFeDistribuicaoDFe e NFeRecepcaoEvento4. Só monta e lê. Não assina (ver
 * `xmldsig.ts`) e não faz rede (ver `sefaz-gateway.ts`), e por isso é testável
 * com o texto que a SEFAZ devolve.
 */

export const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';
export const NS_DIST = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe';
export const NS_EVENTO = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4';
const NS_SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

/** Códigos IBGE das UFs, para `cUFAutor`. */
export const CODIGO_UF: Readonly<Record<string, string>> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
};

export const NSU_ZERO = '000000000000000';

export function nsu(valor: string | number): string {
  return String(valor).replace(/\D/g, '').padStart(15, '0').slice(-15);
}

function envelope(corpo: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="${NS_SOAP12}"><soap12:Body>${corpo}</soap12:Body></soap12:Envelope>`;
}

// --------------------------------------------------------------- distribuição

export interface PedidoDistribuicao {
  tpAmb: 1 | 2;
  cUFAutor: string;
  cnpj: string;
  ultNsu: string;
}

export function envelopeDistribuicao(p: PedidoDistribuicao): string {
  return envelope(
    `<nfeDistDFeInteresse xmlns="${NS_DIST}"><nfeDadosMsg>` +
      `<distDFeInt xmlns="${NS_NFE}" versao="1.01">` +
      `<tpAmb>${p.tpAmb}</tpAmb><cUFAutor>${p.cUFAutor}</cUFAutor><CNPJ>${p.cnpj}</CNPJ>` +
      `<distNSU><ultNSU>${nsu(p.ultNsu)}</ultNSU></distNSU>` +
      `</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse>`,
  );
}

export type EsquemaDfe = 'procNFe' | 'resNFe' | 'resEvento' | 'procEventoNFe' | 'outro';

export interface DocumentoDistribuido {
  nsu: string;
  esquema: EsquemaDfe;
  /** Nome do schema como veio, para o que esta coleta ainda não trata. */
  schema: string;
  xml: string;
}

export interface RespostaDistribuicao {
  cStat: string;
  xMotivo: string;
  ultNsu: string;
  maxNsu: string;
  documentos: DocumentoDistribuido[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // Chave de acesso, NSU e CNPJ são texto: como número perderiam os zeros à
  // esquerda e a precisão.
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (nome) => nome === 'docZip' || nome === 'retEvento',
});

/** Procura um elemento em qualquer profundidade (o envelope SOAP varia). */
function achar(no: unknown, nome: string): Record<string, unknown> | undefined {
  if (no === null || typeof no !== 'object') return undefined;
  const obj = no as Record<string, unknown>;
  if (nome in obj) return obj[nome] as Record<string, unknown>;
  for (const valor of Object.values(obj)) {
    const achado = achar(valor, nome);
    if (achado !== undefined) return achado;
  }
  return undefined;
}

function texto(valor: unknown): string {
  if (valor === undefined || valor === null) return '';
  if (typeof valor === 'object') return String((valor as Record<string, unknown>)['#text'] ?? '');
  return String(valor);
}

function esquemaDe(schema: string): EsquemaDfe {
  if (schema.startsWith('procNFe')) return 'procNFe';
  if (schema.startsWith('resNFe')) return 'resNFe';
  if (schema.startsWith('resEvento')) return 'resEvento';
  if (schema.startsWith('procEventoNFe')) return 'procEventoNFe';
  return 'outro';
}

export class RespostaSefazInvalidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespostaSefazInvalidaError';
  }
}

export function lerRespostaDistribuicao(soap: string): RespostaDistribuicao {
  const ret = achar(parser.parse(soap), 'retDistDFeInt');
  if (ret === undefined) {
    throw new RespostaSefazInvalidaError('A resposta da distribuição não traz retDistDFeInt.');
  }

  const lote = ret['loteDistDFeInt'] as Record<string, unknown> | undefined;
  const zips = (lote?.['docZip'] as unknown[] | undefined) ?? [];

  return {
    cStat: texto(ret['cStat']),
    xMotivo: texto(ret['xMotivo']),
    ultNsu: nsu(texto(ret['ultNSU']) || NSU_ZERO),
    maxNsu: nsu(texto(ret['maxNSU']) || NSU_ZERO),
    documentos: zips.map((z) => {
      const zip = z as Record<string, unknown>;
      const schema = String(zip['@_schema'] ?? '');
      return {
        nsu: nsu(String(zip['@_NSU'] ?? '0')),
        esquema: esquemaDe(schema),
        schema,
        // docZip é o XML compactado em GZip e codificado em base64.
        xml: gunzipSync(Buffer.from(texto(zip), 'base64')).toString('utf8'),
      };
    }),
  };
}

/** Resumo de NF-e (`resNFe`): o que chega antes da ciência da operação. */
export interface ResumoNfe {
  accessKey: string;
  issuerCnpj: string | null;
  issuerName: string | null;
  issuedAt: string | null;
  totalCents: number | null;
}

export function lerResumoNfe(xml: string): ResumoNfe {
  const res = achar(parser.parse(xml), 'resNFe');
  const chave = texto(res?.['chNFe']);
  if (res === undefined || !/^\d{44}$/.test(chave)) {
    throw new RespostaSefazInvalidaError('Resumo de NF-e sem chave de acesso válida.');
  }
  const valor = texto(res['vNF']);
  return {
    accessKey: chave,
    issuerCnpj: texto(res['CNPJ']) || null,
    issuerName: texto(res['xNome']) || null,
    issuedAt: texto(res['dhEmi']) || null,
    totalCents: valor === '' ? null : Math.round(Number(valor) * 100),
  };
}

// --------------------------------------------------------------------- evento

/** Ciência da operação: o evento que libera o XML completo ao destinatário. */
export const TP_CIENCIA = '210210';
const DESC_CIENCIA = 'Ciencia da Operacao';

export interface PedidoCiencia {
  tpAmb: 1 | 2;
  cnpj: string;
  accessKey: string;
  /** `AAAA-MM-DDThh:mm:ss-03:00`. */
  dhEvento: string;
}

/** Id do `infEvento`: `ID` + tipo + chave + sequência com dois dígitos. */
export function idDoEvento(accessKey: string, nSeqEvento = 1): string {
  return `ID${TP_CIENCIA}${accessKey}${String(nSeqEvento).padStart(2, '0')}`;
}

/**
 * Filhos do `infEvento`, na ordem do leiaute. Tudo o que entra aqui são
 * dígitos, a data e um texto ASCII fixo, então nada precisa de escape, e a
 * forma canônica (C14N) é o próprio texto (ver `xmldsig.ts`).
 */
export function corpoDaCiencia(p: PedidoCiencia): string {
  return (
    `<cOrgao>91</cOrgao><tpAmb>${p.tpAmb}</tpAmb><CNPJ>${p.cnpj}</CNPJ>` +
    `<chNFe>${p.accessKey}</chNFe><dhEvento>${p.dhEvento}</dhEvento>` +
    `<tpEvento>${TP_CIENCIA}</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>${DESC_CIENCIA}</descEvento></detEvento>`
  );
}

/** Envelope do lote com um evento já assinado. */
export function envelopeEvento(eventoAssinado: string, idLote: string): string {
  return envelope(
    `<nfeDadosMsg xmlns="${NS_EVENTO}">` +
      `<envEvento xmlns="${NS_NFE}" versao="1.00"><idLote>${idLote}</idLote>${eventoAssinado}</envEvento>` +
      `</nfeDadosMsg>`,
  );
}

export interface RespostaEvento {
  /** cStat do lote (128 = lote processado). */
  cStatLote: string;
  /** cStat do evento: 135 e 136 registrado, 573 duplicidade. */
  cStat: string;
  xMotivo: string;
  protocolo: string | null;
}

/** Evento registrado, ou já registrado antes: nos dois casos, a ciência existe. */
export function cienciaRegistrada(cStat: string): boolean {
  return cStat === '135' || cStat === '136' || cStat === '573';
}

export function lerRespostaEvento(soap: string): RespostaEvento {
  const ret = achar(parser.parse(soap), 'retEnvEvento');
  if (ret === undefined) {
    throw new RespostaSefazInvalidaError('A resposta da recepção de evento não traz retEnvEvento.');
  }
  const evento = ((ret['retEvento'] as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined;
  const inf = evento?.['infEvento'] as Record<string, unknown> | undefined;

  return {
    cStatLote: texto(ret['cStat']),
    // Lote rejeitado inteiro (ex.: 215, falha de schema) não traz retEvento: o
    // motivo é o do lote.
    cStat: texto(inf?.['cStat']) || texto(ret['cStat']),
    xMotivo: texto(inf?.['xMotivo']) || texto(ret['xMotivo']),
    protocolo: texto(inf?.['nProt']) || null,
  };
}

/** Horário de Brasília, que é o que a SEFAZ espera em `dhEvento`. */
export function dataHoraBrasilia(agora: Date): string {
  const local = new Date(agora.getTime() - 3 * 3600_000);
  return `${local.toISOString().slice(0, 19)}-03:00`;
}
