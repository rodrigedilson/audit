import { describe, it, expect } from 'vitest';
import { createSign, createVerify, X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import {
  CertificateError,
  CertificateVault,
  extrairCredencial,
  lerCredencial,
} from '../../../src/fiscal/portfolio/certificate-vault.js';
import { assinarEvento } from '../../../src/fiscal/dfe/xmldsig.js';
import { corpoDaCiencia, idDoEvento } from '../../../src/fiscal/dfe/dfe-xml.js';
import { pfxDeTeste } from '../../helpers/certificado.js';

const MASTER = 'chave-mestra-de-teste-com-mais-de-32-caracteres';
const CHAVE = '35271112345678000195550010000000151234567890';

describe('extrairCredencial (ADR-006)', () => {
  it('reexporta chave e certificado, e o cofre devolve a credencial utilizável', () => {
    const vault = new CertificateVault(MASTER);
    const cifrado = vault.encrypt(extrairCredencial(pfxDeTeste({ password: 'segredo' }), 'segredo'));

    const credencial = lerCredencial(vault.decrypt(cifrado.ciphertext));

    // A chave assina e o certificado verifica: é o par que o mTLS e o evento usam.
    const assinatura = createSign('RSA-SHA1').update('teste').sign(credencial.key);
    expect(createVerify('RSA-SHA1').update('teste').verify(credencial.cert, assinatura)).toBe(true);
  });

  it('não guarda a senha: o pacote é só chave e cadeia', () => {
    const material = extrairCredencial(pfxDeTeste({ password: 'segredo' }), 'segredo').toString('utf8');

    expect(material).not.toContain('segredo');
    expect(Object.keys(JSON.parse(material)).sort()).toEqual(['cert', 'chain', 'key']);
  });

  /** A ordem das bags não é garantida: assinar com a intermediária seria agir em nome de outro. */
  it('com a CA no arquivo, escolhe o titular pela chave, e não pela ordem', () => {
    const credencial = lerCredencial(extrairCredencial(pfxDeTeste({ password: 's', comCadeia: true }), 's'));

    expect(new X509Certificate(credencial.cert).subject).toContain('CLIENTE DE TESTE');
    expect(credencial.chain).toHaveLength(1);
    expect(new X509Certificate(credencial.chain[0]!).subject).toContain('AC TESTE');
  });

  it('senha errada é CertificateError, sem dizer se foi arquivo ou senha', () => {
    expect(() => extrairCredencial(pfxDeTeste({ password: 'certa' }), 'errada')).toThrow(CertificateError);
  });

  /** Certificado guardado antes da coleta é o PFX com senha descartada. */
  it('material antigo (PFX) não passa por credencial', () => {
    expect(() => lerCredencial(pfxDeTeste({ password: 'x' }))).toThrow(/reenviados/);
  });
});

describe('assinarEvento — XMLDSig da ciência da operação', () => {
  const credencial = lerCredencial(extrairCredencial(pfxDeTeste({ password: 's' }), 's'));
  const id = idDoEvento(CHAVE);
  const corpo = corpoDaCiencia({ tpAmb: 1, cnpj: '12345678000195', accessKey: CHAVE, dhEvento: '2027-11-20T10:00:00-03:00' });
  const evento = assinarEvento(id, corpo, credencial);

  /**
   * Verificação independente: o xml-crypto canonicaliza por conta própria, e
   * se a forma canônica construída à mão divergisse em um byte, o digest não
   * bateria.
   */
  it('a assinatura confere numa verificação independente', () => {
    const doc = new DOMParser().parseFromString(evento, 'text/xml');
    const assinatura = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0]!;
    const sig = new SignedXml({ publicCert: credencial.cert });
    sig.loadSignature(assinatura as unknown as Parameters<SignedXml['loadSignature']>[0]);

    expect(sig.checkSignature(evento)).toBe(true);
  });

  it('adulterar o evento depois de assinado invalida a assinatura', () => {
    // Troca a chave da nota no conteúdo, mantendo o Id que a referência aponta.
    const adulterado = evento.replace(`<chNFe>${CHAVE}`, `<chNFe>${CHAVE.replace(/0$/, '1')}`);
    const doc = new DOMParser().parseFromString(adulterado, 'text/xml');
    const sig = new SignedXml({ publicCert: credencial.cert });
    sig.loadSignature(doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0] as unknown as Parameters<SignedXml['loadSignature']>[0]);

    let valida: boolean;
    try {
      valida = sig.checkSignature(adulterado);
    } catch {
      valida = false;
    }
    expect(valida).toBe(false);
  });

  it('segue o leiaute: Id, cOrgao 91, 210210, descrição sem acento e X509 do titular', () => {
    expect(id).toBe(`ID210210${CHAVE}01`);
    expect(evento).toContain(`<infEvento Id="${id}"><cOrgao>91</cOrgao>`);
    expect(evento).toContain('<descEvento>Ciencia da Operacao</descEvento>');
    expect(evento).toContain('rsa-sha1');
    const x509 = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(evento)![1]!;
    expect(new X509Certificate(Buffer.from(x509, 'base64')).subject).toContain('CLIENTE DE TESTE');
  });
});
