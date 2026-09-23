import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import {
  CertificateVault,
  CertificateError,
  readCertificateMetadata,
  daysToExpiry,
} from '../../../src/fiscal/portfolio/certificate-vault.js';

const MASTER_KEY = 'chave-mestra-de-teste-com-mais-de-32-caracteres';

/**
 * Gera um PFX de verdade, para exercitar o parser PKCS#12 em vez de mocká-lo. Um
 * mock aqui provaria só que o mock funciona, e o parsing é justamente a parte
 * que pode quebrar com certificado real da ICP-Brasil.
 */
function makePfx(options: { password: string; cn?: string; daysValid?: number }): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0A1B2C3D';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date(Date.now() + (options.daysValid ?? 365) * 86_400_000);

  const subject = [
    { shortName: 'CN', value: options.cn ?? 'CLIENTE DE TESTE:12345678000195' },
    { shortName: 'C', value: 'BR' },
  ];
  const issuer = [{ shortName: 'CN', value: 'AC TESTE ICP-BRASIL' }, { shortName: 'C', value: 'BR' }];

  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.sign(keys.privateKey);

  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], options.password);
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

describe('CertificateVault', () => {
  const vault = new CertificateVault(MASTER_KEY);

  it('cifra e decifra o PFX sem perder um byte', () => {
    const pfx = makePfx({ password: 'senha-do-certificado' });

    const encrypted = vault.encrypt(pfx);

    expect(vault.decrypt(encrypted.ciphertext).equals(pfx)).toBe(true);
  });

  it('o ciphertext não contém o conteúdo em claro', () => {
    const pfx = Buffer.from('conteudo-secreto-do-pfx');

    const { ciphertext } = vault.encrypt(pfx);

    expect(ciphertext).not.toContain('conteudo-secreto');
    expect(Buffer.from(ciphertext.split(':')[2]!, 'base64').equals(pfx)).toBe(false);
  });

  /** IV aleatório por cifragem: sem isso, PFX iguais gerariam ciphertext igual. */
  it('cifra o mesmo PFX em ciphertexts diferentes', () => {
    const pfx = Buffer.from('mesmo-conteudo');

    expect(vault.encrypt(pfx).ciphertext).not.toBe(vault.encrypt(pfx).ciphertext);
  });

  it('a fingerprint é estável e identifica o arquivo', () => {
    const pfx = Buffer.from('conteudo');

    expect(vault.encrypt(pfx).fingerprint).toBe(vault.encrypt(pfx).fingerprint);
    expect(vault.encrypt(pfx).fingerprint).not.toBe(
      vault.encrypt(Buffer.from('outro')).fingerprint,
    );
  });

  /**
   * É o que impede alguém com acesso de escrita ao banco de trocar o
   * certificado: o GCM autentica, então adulteração falha em vez de devolver
   * bytes corrompidos.
   */
  it('recusa ciphertext adulterado', () => {
    const { ciphertext } = vault.encrypt(Buffer.from('conteudo-original'));
    const [iv, tag] = ciphertext.split(':');
    const adulterado = [iv, tag, Buffer.from('conteudo-trocado!').toString('base64')].join(':');

    expect(() => vault.decrypt(adulterado)).toThrow(CertificateError);
  });

  it('recusa decifrar com outra chave mestra', () => {
    const { ciphertext } = vault.encrypt(Buffer.from('conteudo'));
    const outroVault = new CertificateVault('outra-chave-mestra-com-mais-de-32-caracteres');

    expect(() => outroVault.decrypt(ciphertext)).toThrow(/chave mestra incorreta|adulterado/);
  });

  it('recusa formato inválido', () => {
    expect(() => vault.decrypt('sem-separadores')).toThrow(/formato inválido/);
  });

  it('recusa chave mestra curta em vez de derivar algo fraco', () => {
    expect(() => new CertificateVault('curta')).toThrow(/ao menos 32 caracteres/);
  });
});

/**
 * Rotação da chave mestra.
 *
 * É o cenário que não podia existir antes: trocar a chave tornava ilegível todo
 * PFX já guardado, e não há recuperação — a senha do certificado não é guardada
 * em lugar nenhum.
 */
describe('CertificateVault — rotação', () => {
  const NOVA = 'chave-mestra-nova-com-mais-de-32-caracteres-aqui';
  const ANTIGA = MASTER_KEY;

  it('o cofre novo abre o que a chave antiga cifrou', () => {
    const pfx = Buffer.from('pfx-cifrado-antes-da-rotacao');
    const antesDaRotacao = new CertificateVault(ANTIGA).encrypt(pfx);

    const depoisDaRotacao = new CertificateVault(NOVA, ANTIGA);

    expect(depoisDaRotacao.decrypt(antesDaRotacao.ciphertext).equals(pfx)).toBe(true);
  });

  /** Sem a anterior, o mesmo dado é ilegível — e a mensagem diz o que fazer. */
  it('sem a chave anterior, o dado antigo não abre', () => {
    const antesDaRotacao = new CertificateVault(ANTIGA).encrypt(Buffer.from('pfx'));

    const semAAnterior = new CertificateVault(NOVA);

    expect(() => semAAnterior.decrypt(antesDaRotacao.ciphertext)).toThrow(
      /CERTIFICATE_MASTER_KEY_PREVIOUS/,
    );
  });

  it('cifra sempre com a atual, mesmo tendo a anterior', () => {
    const cofre = new CertificateVault(NOVA, ANTIGA);

    const cifrado = cofre.encrypt(Buffer.from('pfx'));

    expect(cifrado.keyId).toBe(cofre.keyId);
    expect(cifrado.keyId).not.toBe(cofre.previousKeyId);
    // E o que ele cifrou abre num cofre que só tem a nova: é o que permite
    // remover a anterior do ambiente depois da recifragem.
    expect(new CertificateVault(NOVA).decrypt(cifrado.ciphertext)).toBeTruthy();
  });

  /**
   * O id é derivado da chave, e não configurado à mão: é o que permite ao script
   * de recifragem saber quais linhas faltam sem ninguém lembrar de incrementar
   * um número de versão.
   */
  it('o id identifica a chave e não a revela', () => {
    const umCofre = new CertificateVault(ANTIGA);
    const oMesmo = new CertificateVault(ANTIGA);
    const outro = new CertificateVault(NOVA);

    expect(umCofre.keyId).toBe(oMesmo.keyId);
    expect(umCofre.keyId).not.toBe(outro.keyId);
    expect(umCofre.keyId).toHaveLength(16);
    expect(ANTIGA).not.toContain(umCofre.keyId);
  });

  /** Variável esquecida no ambiente é erro, não configuração silenciosa. */
  it('recusa a anterior igual à atual', () => {
    expect(() => new CertificateVault(NOVA, NOVA)).toThrow(/igual à atual/);
  });

  it('anterior vazia é o mesmo que não ter anterior', () => {
    expect(new CertificateVault(NOVA, '').previousKeyId).toBeNull();
  });
});

describe('readCertificateMetadata', () => {
  it('extrai titular, emissor, serial e validade de um PFX real', () => {
    const pfx = makePfx({ password: 'senha-forte', cn: 'EMPRESA EXEMPLO:12345678000195' });

    const metadata = readCertificateMetadata(pfx, 'senha-forte');

    expect(metadata.subject).toContain('EMPRESA EXEMPLO:12345678000195');
    expect(metadata.issuer).toContain('AC TESTE ICP-BRASIL');
    expect(metadata.serial.toLowerCase()).toContain('a1b2c3d');
    expect(new Date(metadata.valid_to).getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * Mensagem única para arquivo inválido e senha errada: a diferença serviria
   * para descobrir a senha por tentativa e erro.
   */
  it('não distingue senha errada de arquivo inválido na mensagem', () => {
    const pfx = makePfx({ password: 'senha-correta' });

    const porSenha = (() => {
      try {
        readCertificateMetadata(pfx, 'senha-errada');
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();

    const porArquivo = (() => {
      try {
        readCertificateMetadata(Buffer.from('isto-nao-e-um-pfx'), 'qualquer');
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(porSenha).toBe(porArquivo);
    expect(porSenha).toMatch(/arquivo ou senha inválidos/);
  });
});

describe('daysToExpiry', () => {
  it('conta os dias que faltam', () => {
    const agora = new Date('2027-01-01T00:00:00Z');

    expect(daysToExpiry('2027-03-02T00:00:00Z', agora)).toBe(60);
  });

  it('devolve negativo para certificado já vencido', () => {
    const agora = new Date('2027-01-10T00:00:00Z');

    expect(daysToExpiry('2027-01-01T00:00:00Z', agora)).toBeLessThan(0);
  });
});
