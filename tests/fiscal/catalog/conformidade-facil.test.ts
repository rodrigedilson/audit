import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ConformidadeFacilError,
  consultarClassTrib,
  credencialDoAmbiente,
  validarTabelaClassTrib,
  type TransporteCff,
} from '../../../src/fiscal/catalog/conformidade-facil.client.js';

/**
 * O que dá para verificar sem um certificado ICP-Brasil.
 *
 * O handshake mTLS em si não tem teste: ele exige um A1 válido e uma conexão com
 * a SVRS. O que se testa é tudo em volta dele — a credencial antes, e a resposta
 * depois, por um transporte dublado —, que é onde os erros são silenciosos.
 */
describe('credencialDoAmbiente', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Ausência de certificado é o caso normal: a maioria das máquinas não tem um
   * A1 à mão. Lançar aqui faria o carregador falhar em vez de cair para a
   * raspagem do portal.
   */
  it('sem CFF_CERT_PFX devolve nulo, e não lança', async () => {
    vi.stubEnv('CFF_CERT_PFX', '');

    await expect(credencialDoAmbiente()).resolves.toBeNull();
  });

  /**
   * Meia configuração, por outro lado, é engano. Sem a senha o handshake falha
   * com erro de leitura do PFX, que não diz que o problema é a senha — e a
   * pessoa vai procurar o defeito no certificado.
   */
  it('com o PFX e sem a senha, falha dizendo qual é o problema', async () => {
    vi.stubEnv('CFF_CERT_PFX', '/tmp/certificado.pfx');
    vi.stubEnv('CFF_CERT_PASSWORD', '');

    await expect(credencialDoAmbiente()).rejects.toThrow(ConformidadeFacilError);
    await expect(credencialDoAmbiente()).rejects.toThrow(/CFF_CERT_PASSWORD/);
  });

  it('com os dois, lê o arquivo — e o erro de arquivo ausente chega cru', async () => {
    vi.stubEnv('CFF_CERT_PFX', '/caminho/que/nao/existe.pfx');
    vi.stubEnv('CFF_CERT_PASSWORD', 'senha');

    await expect(credencialDoAmbiente()).rejects.toThrow(/ENOENT|no such file/);
  });
});

const CREDENCIAL = { pfx: Buffer.from('pfx'), passphrase: 'senha' };

const TABELA = [
  {
    Cst: '000',
    NomeCst: 'Tributação integral',
    DthIniVig: '2025-01-01T00:00:00',
    DthFimVig: null,
    ClassificacoesTributarias: [
      {
        CodClassTrib: '000001',
        NomeClassTrib: 'Situações tributadas integralmente pelo IBS e CBS.',
        Cst: '000',
        DthIniVig: '2025-01-01T00:00:00',
        DthFimVig: null,
        TexUrlLegislacao: 'https://www.planalto.gov.br/lcp214',
      },
    ],
  },
];

const responde = (status: number, body: string): TransporteCff => async () => ({ status, body });

describe('consultarClassTrib — a resposta da SVRS', () => {
  it('devolve a tabela validada, e pede o caminho com o filtro de CST', async () => {
    const caminhos: string[] = [];
    const transporte: TransporteCff = async (_c, caminho) => {
      caminhos.push(caminho);
      return { status: 200, body: JSON.stringify(TABELA) };
    };

    expect(await consultarClassTrib(CREDENCIAL, '000', transporte)).toEqual(TABELA);
    expect(caminhos).toEqual(['/api/v1/consultas/classTrib?cst=000']);
  });

  it.each([401, 403])('%i é certificado recusado, e diz o que o acesso exige', async (status) => {
    const erro = await consultarClassTrib(CREDENCIAL, undefined, responde(status, '')).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ConformidadeFacilError);
    expect(erro).toMatchObject({ status });
    expect((erro as Error).message).toMatch(/ICP-Brasil/);
  });

  it('outro status traz o começo do corpo', async () => {
    await expect(consultarClassTrib(CREDENCIAL, undefined, responde(502, 'Bad Gateway do balanceador'))).rejects.toThrow(
      /502: Bad Gateway/,
    );
  });

  it('corpo que não é JSON é endpoint mudado ou proxy', async () => {
    await expect(consultarClassTrib(CREDENCIAL, undefined, responde(200, '<html>login</html>'))).rejects.toThrow(
      /não é JSON/,
    );
  });

  it('JSON fora do formato é recusado antes do banco', async () => {
    await expect(consultarClassTrib(CREDENCIAL, undefined, responde(200, '{"erro":"x"}'))).rejects.toThrow(
      /array não vazio/,
    );
  });
});

describe('validarTabelaClassTrib', () => {
  const com = (mudar: (t: typeof TABELA) => void): unknown => {
    const copia = structuredClone(TABELA);
    mudar(copia);
    return copia;
  };

  it('aceita a tabela como a SVRS publica', () => {
    expect(validarTabelaClassTrib(TABELA)).toHaveLength(1);
  });

  it('aponta o registro sem campo obrigatório, pelo índice', () => {
    expect(() =>
      validarTabelaClassTrib(com((t) => { (t[0]!.ClassificacoesTributarias![0] as Record<string, unknown>)['NomeClassTrib'] = ''; })),
    ).toThrow('CST[0].ClassificacoesTributarias[0].NomeClassTrib ausente.');
  });

  it('recusa código fora do formato: cClassTrib tem 6 dígitos, CST tem 3', () => {
    expect(() => validarTabelaClassTrib(com((t) => { t[0]!.ClassificacoesTributarias![0]!.CodClassTrib = '1'; }))).toThrow(
      /CodClassTrib/,
    );
    expect(() => validarTabelaClassTrib(com((t) => { t[0]!.Cst = '00A'; }))).toThrow(/CST\[0\]\.Cst/);
  });

  it('recusa vigência que não é data nem nulo', () => {
    expect(() => validarTabelaClassTrib(com((t) => { (t[0] as Record<string, unknown>)['DthIniVig'] = 'ontem'; }))).toThrow(
      /DthIniVig/,
    );
  });

  it('recusa tabela vazia: a carga terminaria sem nada e diria que deu certo', () => {
    expect(() => validarTabelaClassTrib([])).toThrow(/array não vazio/);
  });
});
