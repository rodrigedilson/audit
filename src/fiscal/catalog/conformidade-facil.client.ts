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

/**
 * Consulta a tabela de classificação tributária.
 *
 * `cst` filtra por um CST específico; sem ele, vem a tabela inteira.
 */
export async function consultarClassTrib(
  credencial: CredencialDeCertificado,
  cst?: string,
): Promise<unknown> {
  const caminho = cst === undefined ? CAMINHO : `${CAMINHO}?cst=${encodeURIComponent(cst)}`;

  return new Promise((resolve, reject) => {
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
        resposta.on('end', () => {
          const corpo = Buffer.concat(pedacos).toString('utf8');
          const status = resposta.statusCode ?? 0;

          if (status === 401 || status === 403) {
            reject(
              new ConformidadeFacilError(
                `A SVRS recusou o certificado (${status}). O acesso é gratuito, mas ` +
                  'exige ICP-Brasil válido e não vencido.',
                status,
              ),
            );
            return;
          }

          if (status < 200 || status >= 300) {
            reject(
              new ConformidadeFacilError(
                `A SVRS respondeu ${status}: ${corpo.slice(0, 200)}`,
                status,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(corpo));
          } catch {
            reject(
              new ConformidadeFacilError(
                'A resposta não é JSON. O endpoint mudou, ou um proxy interveio.',
              ),
            );
          }
        });
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
}
