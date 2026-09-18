import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import forge from 'node-forge';

/**
 * Cofre do certificado A1 do cliente.
 *
 * O PFX é material que permite agir em nome do contribuinte perante o Fisco. Por
 * isso: cifrado em repouso com AES-256-GCM, chave mestra fora do banco, e **nunca
 * devolvido pela API** — só metadados. Todo uso vira evento `certificate.used`,
 * o que dá ao escritório uma trilha melhor do que a do concorrente.
 *
 * Custodiar certificado de terceiro é também o que torna a certificação de
 * segurança (ISO 27001 / SOC 2) um pré-requisito comercial, não um luxo.
 */

export class CertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateError';
  }
}

export interface CertificateMetadata {
  subject: string;
  issuer: string;
  serial: string;
  valid_from: string;
  valid_to: string;
}

export interface EncryptedCertificate {
  /** `iv:authTag:ciphertext`, tudo em base64. */
  ciphertext: string;
  /** SHA-256 do PFX em claro, para detectar troca silenciosa do arquivo. */
  fingerprint: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Deriva a chave de 32 bytes da chave mestra. `scrypt` seria melhor para senha
 * humana; aqui a mestra já é material aleatório de 32+ bytes, e o SHA-256 só
 * normaliza o tamanho.
 */
function deriveKey(masterKey: string): Buffer {
  if (masterKey.trim().length < 32) {
    throw new CertificateError(
      'CERTIFICATE_MASTER_KEY deve ter ao menos 32 caracteres. ' +
        'Gere com: openssl rand -base64 48',
    );
  }
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export class CertificateVault {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = deriveKey(masterKey);
  }

  encrypt(pfx: Buffer): EncryptedCertificate {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(pfx), cipher.final()]);

    return {
      ciphertext: [
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      ].join(':'),
      fingerprint: createHash('sha256').update(pfx).digest('hex'),
    };
  }

  /**
   * O GCM autentica: um ciphertext adulterado falha na verificação do authTag em
   * vez de devolver bytes corrompidos. É o que impede alguém com acesso ao banco
   * de trocar o certificado por outro sem que se perceba.
   */
  decrypt(stored: string): Buffer {
    const [ivB64, tagB64, dataB64] = stored.split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new CertificateError('Certificado cifrado em formato inválido.');
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    try {
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]);
    } catch {
      throw new CertificateError(
        'Falha ao decifrar o certificado: chave mestra incorreta ou dado adulterado.',
      );
    }
  }
}

/**
 * Extrai metadados do PFX. A senha é usada só para abrir o arquivo e **não** é
 * guardada: guardá-la ao lado do PFX cifrado anularia a cifragem.
 */
export function readCertificateMetadata(pfx: Buffer, password: string): CertificateMetadata {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch {
    // Não distingue "arquivo inválido" de "senha errada": a diferença serviria
    // para descobrir a senha por tentativa.
    throw new CertificateError('Não foi possível abrir o certificado: arquivo ou senha inválidos.');
  }

  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certificate = bags.map((bag) => bag.cert).find((cert): cert is forge.pki.Certificate => !!cert);

  if (!certificate) {
    throw new CertificateError('O arquivo não contém certificado.');
  }

  return {
    subject: certificate.subject.attributes
      .map((attribute) => `${attribute.shortName ?? attribute.name}=${String(attribute.value)}`)
      .join(', '),
    issuer: certificate.issuer.attributes
      .map((attribute) => `${attribute.shortName ?? attribute.name}=${String(attribute.value)}`)
      .join(', '),
    serial: certificate.serialNumber,
    valid_from: certificate.validity.notBefore.toISOString(),
    valid_to: certificate.validity.notAfter.toISOString(),
  };
}

export function daysToExpiry(validTo: string, now: Date = new Date()): number {
  const millis = new Date(validTo).getTime() - now.getTime();
  return Math.floor(millis / 86_400_000);
}
