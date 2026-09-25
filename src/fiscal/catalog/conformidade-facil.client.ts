import { request } from 'node:https';
import { readFile } from 'node:fs/promises';

/**
 * Cliente da API pública do Conformidade Fácil (SVRS).
 *
 * `https://cff.svrs.rs.gov.br/api/v1/consultas/classTrib` devolve as tabelas de
 * CST-IBS/CBS e cClassTrib do Informe Técnico RT 2025.002 em JSON. É a fonte
 * definitiva: hoje o carregador raspa a mesma tabela da página do portal, o que
 * funciona e quebra quando a página mudar de forma.
 *
 * O acesso é gratuito e exige **autenticação mútua com certificado ICP-Brasil**
 * (x.509). Daí a existência deste cliente separado: `fetch` do Node não expõe
 * certificado de cliente, e a chamada precisa de `node:https` com o PFX.
 *
 * **De onde vem o certificado.** De um arquivo que o operador aponta —
 * `CFF_CERT_PFX` e `CFF_CERT_PASSWORD`. Não vem do cofre de propósito: o cofre
 * guarda o A1 **de cada cliente**, e este certificado é da operação, usado para
 * carregar tabela global de referência. Ver
 * `docs/adr/ADR-007-uso-nao-assistido-do-certificado.md`.
 *
 * A SVRS pede uma consulta por dia por empresa — as tabelas não mudam
 * diariamente, e laço contínuo é uso indevido do serviço.
 */

export interface CredencialDeCertificado {
  /** Conteúdo do PFX. */
  pfx: Buffer;
  /** Senha que abre o PFX. Não é guardada em lugar nenhum pelo sistema. */
  passphrase: string;
}

export class ConformidadeFacilError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConformidadeFacilError';
  }
}

const HOST = 'cff.svrs.rs.gov.br';
const CAMINHO = '/api/v1/consultas/classTrib';

/**
 * Lê a credencial das variáveis de ambiente.
 *
 * Devolve `null` quando não há credencial configurada, e **não** lança: quem
 * chama decide se cai para a raspagem do portal ou se para. Tratar ausência de
 * certificado como erro faria o carregador falhar em toda máquina que não tem
 * um A1 à mão, que é a maioria.
 */
export async function credencialDoAmbiente(): Promise<CredencialDeCertificado | null> {
  const caminho = process.env['CFF_CERT_PFX']?.trim();
  const passphrase = process.env['CFF_CERT_PASSWORD'];

  if (caminho === undefined || caminho === '') {
    return null;
  }

  if (passphrase === undefined || passphrase === '') {
    throw new ConformidadeFacilError(
      'CFF_CERT_PFX está definido e CFF_CERT_PASSWORD não. O PFX é protegido por ' +
        'senha, e sem ela o handshake falha com erro de leitura do arquivo — que ' +
        'não diz que o problema é a senha.',
    );
  }

  return { pfx: await readFile(caminho), passphrase };
}

/** cClassTrib da tabela, no formato da SVRS. */
export interface ClassificacaoTributaria {
  CodClassTrib: string;
  NomeClassTrib: string;
  Cst: string;
  DthIniVig: string | null;
  DthFimVig: string | null;
  TexUrlLegislacao?: string | null;
}

/** CST-IBS/CBS com as cClassTrib dele, no formato da SVRS. */
export interface RegistroDeCst {
  Cst: string;
  NomeCst: string;
  DthIniVig: string | null;
  DthFimVig: string | null;
  ClassificacoesTributarias?: ClassificacaoTributaria[];
}

/** Resposta crua do servidor: o transporte não interpreta nada. */
export interface RespostaHttp {
  status: number;
  body: string;
}

export type TransporteCff = (
  credencial: CredencialDeCertificado,
  caminho: string,
) => Promise<RespostaHttp>;

/**
 * Consulta a tabela de classificação tributária e devolve os registros já
 * validados. `cst` filtra por um CST; sem ele, vem a tabela inteira.
 *
 * O transporte é injetável para os testes exercitarem a resposta (401, JSON
 * inválido, formato inesperado) sem certificado nem rede.
 */
export async function consultarClassTrib(
  credencial: CredencialDeCertificado,
  cst?: string,
  transporte: TransporteCff = transporteHttps,
): Promise<RegistroDeCst[]> {
  const caminho = cst === undefined ? CAMINHO : `${CAMINHO}?cst=${encodeURIComponent(cst)}`;
  return validarTabelaClassTrib(interpretarResposta(await transporte(credencial, caminho)));
}

/** Status e corpo viram o JSON da tabela, ou um erro que diz o que aconteceu. */
export function interpretarResposta({ status, body }: RespostaHttp): unknown {
  if (status === 401 || status === 403) {
    throw new ConformidadeFacilError(
      `A SVRS recusou o certificado (${status}). O acesso é gratuito, mas ` +
        'exige ICP-Brasil válido e não vencido.',
      status,
    );
  }
  if (status < 200 || status >= 300) {
    throw new ConformidadeFacilError(`A SVRS respondeu ${status}: ${body.slice(0, 200)}`, status);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ConformidadeFacilError('A resposta não é JSON. O endpoint mudou, ou um proxy interveio.');
  }
}

const DATA = /^\d{4}-\d{2}-\d{2}/;

/**
 * Confere a tabela campo a campo antes de ela chegar ao banco.
 *
 * Registro sem campo obrigatório não é "quase certo": carregado, ele vira par
 * CST × cClassTrib inválido, ou código sem descrição, e a camada 3 passa a
 * aceitar ou recusar o que não devia. A falha aponta o primeiro registro ruim,
 * pelo índice, para dar para comparar com a página do portal.
 *
 * Serve às três fontes do carregador — API, arquivo exportado e raspagem —,
 * porque o formato é o mesmo e o risco também.
 */
export function validarTabelaClassTrib(dados: unknown): RegistroDeCst[] {
  if (!Array.isArray(dados) || dados.length === 0) {
    throw new ConformidadeFacilError(
      'A tabela não tem o formato esperado: um array não vazio de CSTs com ' +
        '`ClassificacoesTributarias` aninhadas.',
    );
  }

  dados.forEach((r: unknown, i) => {
    const onde = `CST[${i}]`;
    const reg = objeto(r, onde);
    codigo(reg['Cst'], /^\d{3}$/, `${onde}.Cst`);
    textoObrigatorio(reg['NomeCst'], `${onde}.NomeCst`);
    dataOuNulo(reg['DthIniVig'], `${onde}.DthIniVig`);
    dataOuNulo(reg['DthFimVig'], `${onde}.DthFimVig`);

    const classificacoes = reg['ClassificacoesTributarias'];
    if (classificacoes === undefined || classificacoes === null) return;
    if (!Array.isArray(classificacoes)) {
      throw new ConformidadeFacilError(`${onde}.ClassificacoesTributarias não é uma lista.`);
    }
    classificacoes.forEach((c: unknown, j) => {
      const aqui = `${onde}.ClassificacoesTributarias[${j}]`;
      const cls = objeto(c, aqui);
      codigo(cls['CodClassTrib'], /^\d{6}$/, `${aqui}.CodClassTrib`);
      textoObrigatorio(cls['NomeClassTrib'], `${aqui}.NomeClassTrib`);
      codigo(cls['Cst'], /^\d{3}$/, `${aqui}.Cst`);
      dataOuNulo(cls['DthIniVig'], `${aqui}.DthIniVig`);
      dataOuNulo(cls['DthFimVig'], `${aqui}.DthFimVig`);
      const url = cls['TexUrlLegislacao'];
      if (url !== undefined && url !== null && typeof url !== 'string') {
        throw new ConformidadeFacilError(`${aqui}.TexUrlLegislacao não é texto.`);
      }
    });
  });

  return dados as RegistroDeCst[];
}

function objeto(valor: unknown, onde: string): Record<string, unknown> {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ConformidadeFacilError(`${onde} não é um objeto.`);
  }
  return valor as Record<string, unknown>;
}

function codigo(valor: unknown, formato: RegExp, onde: string): void {
  if (typeof valor !== 'string' || !formato.test(valor)) {
    throw new ConformidadeFacilError(`${onde} ausente ou fora do formato: ${JSON.stringify(valor)}.`);
  }
}

function textoObrigatorio(valor: unknown, onde: string): void {
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new ConformidadeFacilError(`${onde} ausente.`);
  }
}

function dataOuNulo(valor: unknown, onde: string): void {
  if (valor !== null && (typeof valor !== 'string' || !DATA.test(valor))) {
    throw new ConformidadeFacilError(`${onde} não é data nem nulo: ${JSON.stringify(valor)}.`);
  }
}

/** mTLS com `node:https`: `fetch` do Node não expõe certificado de cliente. */
const transporteHttps: TransporteCff = (credencial, caminho) =>
  new Promise((resolve, reject) => {
    const requisicao = request(
      {
        host: HOST,
        path: caminho,
        method: 'GET',
        pfx: credencial.pfx,
        passphrase: credencial.passphrase,
        headers: { accept: 'application/json' },
        timeout: 30_000,
      },
      (resposta) => {
        const pedacos: Buffer[] = [];
        resposta.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
        resposta.on('end', () =>
          resolve({ status: resposta.statusCode ?? 0, body: Buffer.concat(pedacos).toString('utf8') }),
        );
      },
    );

    requisicao.on('timeout', () => {
      requisicao.destroy();
      reject(new ConformidadeFacilError('A SVRS não respondeu em 30 segundos.'));
    });

    // Falha de handshake chega aqui, e a mensagem crua do OpenSSL não ajuda
    // ninguém: `unable to load PFX` é senha errada tanto quanto arquivo inválido.
    requisicao.on('error', (erro: NodeJS.ErrnoException) => {
      const pistaDeSenha =
        typeof erro.message === 'string' && /PKCS12|PFX|mac verify/i.test(erro.message);

      reject(
        new ConformidadeFacilError(
          pistaDeSenha
            ? `Não foi possível abrir o certificado: arquivo inválido ou senha errada. (${erro.message})`
            : `Falha na conexão com a SVRS: ${erro.message}`,
        ),
      );
    });

    requisicao.end();
  });
