import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ConformidadeFacilError,
  credencialDoAmbiente,
} from '../../../src/fiscal/catalog/conformidade-facil.client.js';

/**
 * O que dá para verificar sem um certificado ICP-Brasil.
 *
 * A chamada autenticada em si **não tem teste**: ela exige um A1 válido e uma
 * conexão com a SVRS, e nenhum dos dois cabe numa suíte. O que se testa aqui é
 * tudo que acontece antes do handshake — que é onde os erros são silenciosos.
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
