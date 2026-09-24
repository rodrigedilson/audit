import { request } from 'node:https';
import type { CredencialA1 } from '../portfolio/certificate-vault.js';
import {
  corpoDaCiencia,
  envelopeDistribuicao,
  envelopeEvento,
  idDoEvento,
  lerRespostaDistribuicao,
  lerRespostaEvento,
  NS_DIST,
  NS_EVENTO,
  type PedidoCiencia,
  type PedidoDistribuicao,
  type RespostaDistribuicao,
  type RespostaEvento,
} from './dfe-xml.js';
import { assinarEvento } from './xmldsig.js';

/**
 * O que a coleta pede à SEFAZ. É a porta: o serviço depende dela, e os testes a
 * trocam por um dublê. Dev nunca fala com a SEFAZ, porque o banco é o de
 * produção (ADR-006).
 */
export interface SefazDfeGateway {
  distribuir(credencial: CredencialA1, pedido: PedidoDistribuicao): Promise<RespostaDistribuicao>;
  manifestarCiencia(credencial: CredencialA1, pedido: PedidoCiencia): Promise<RespostaEvento>;
}

/** Ambiente Nacional, produção. Ver ADR-006 para a cadeia TLS de cada um. */
export const ENDPOINTS_PRODUCAO = {
  distribuicao: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  evento: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
} as const;

/** Uma chamada SOAP com mTLS. Injetável para os testes, que não fazem rede. */
export type TransporteSoap = (
  url: string,
  acao: string,
  corpo: string,
  credencial: CredencialA1,
) => Promise<string>;

export class SefazIndisponivelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SefazIndisponivelError';
  }
}

/** mTLS pelo certificado do contribuinte. A verificação TLS nunca é desligada. */
export const transporteHttps: TransporteSoap = (url, acao, corpo, credencial) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        key: credencial.key,
        cert: [credencial.cert, ...credencial.chain].join('\n'),
        headers: {
          'Content-Type': `application/soap+xml; charset=utf-8; action="${acao}"`,
          'Content-Length': Buffer.byteLength(corpo, 'utf8'),
        },
        timeout: 60_000,
      },
      (res) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          // O SOAP devolve falha como 500 com Fault no corpo; o parser da
          // resposta decide. 5xx sem corpo SOAP é indisponibilidade.
          if ((res.statusCode ?? 500) >= 500 && !texto.includes('Envelope')) {
            reject(new SefazIndisponivelError(`SEFAZ respondeu ${res.statusCode}.`));
            return;
          }
          resolve(texto);
        });
      },
    );
    req.on('timeout', () => req.destroy(new SefazIndisponivelError('SEFAZ não respondeu em 60s.')));
    req.on('error', (erro) =>
      reject(erro instanceof SefazIndisponivelError ? erro : new SefazIndisponivelError(erro.message)),
    );
    req.end(corpo, 'utf8');
  });

export class SefazSoapClient implements SefazDfeGateway {
  constructor(
    private readonly transporte: TransporteSoap = transporteHttps,
    private readonly endpoints: { distribuicao: string; evento: string } = ENDPOINTS_PRODUCAO,
  ) {}

  async distribuir(credencial: CredencialA1, pedido: PedidoDistribuicao): Promise<RespostaDistribuicao> {
    const resposta = await this.transporte(
      this.endpoints.distribuicao,
      `${NS_DIST}/nfeDistDFeInteresse`,
      envelopeDistribuicao(pedido),
      credencial,
    );
    return lerRespostaDistribuicao(resposta);
  }

  async manifestarCiencia(credencial: CredencialA1, pedido: PedidoCiencia): Promise<RespostaEvento> {
    const evento = assinarEvento(idDoEvento(pedido.accessKey), corpoDaCiencia(pedido), credencial);
    // idLote: até 15 dígitos, único por envio. O relógio basta — um lote por
    // chamada, e a SEFAZ não exige sequência.
    const idLote = String(Date.now()).slice(-15);
    const resposta = await this.transporte(
      this.endpoints.evento,
      `${NS_EVENTO}/nfeRecepcaoEvento`,
      envelopeEvento(evento, idLote),
      credencial,
    );
    return lerRespostaEvento(resposta);
  }
}
