import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';
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
  /** Qual chave cifrou. Ver `keyId`. */
  keyId: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Rótulo do identificador de chave. Fixo: mudá-lo renomeia todas as chaves e
 * faz o acervo inteiro parecer cifrado por uma chave desconhecida.
 */
const KEY_ID_LABEL = 'certificate-vault-key-id';

/**
 * Deriva a chave de 32 bytes da chave mestra. `scrypt` seria melhor para senha
 * humana; aqui a mestra já é material aleatório de 32+ bytes, e o SHA-256 só
 * normaliza o tamanho.
 */
function deriveKey(masterKey: string): Buffer {
  /**
   * `trim` **antes** do hash, e não só na validação.
   *
   * O hash era do valor cru: a mesma chave com um `\n` a mais — de um
   * `openssl rand | pipe`, de um copiar e colar no painel do secret manager —
   * derivava uma chave diferente. O sintoma seria "chave mestra incorreta" sobre
   * um acervo cifrado com a chave certa, e não há recuperação.
   *
   * Trocar isto depois de haver certificado guardado tornaria ilegível o que foi
   * cifrado com a chave contendo espaço nas pontas. Feito enquanto o acervo de
   * produção está vazio, que é a única janela em que é de graça.
   */
  const chave = masterKey.trim();

  if (chave.length < 32) {
    throw new CertificateError(
      'CERTIFICATE_MASTER_KEY deve ter ao menos 32 caracteres. ' +
        'Gere com: openssl rand -base64 48',
    );
  }
  return createHash('sha256').update(chave, 'utf8').digest();
}

/**
 * Identificador público da chave.
 *
 * HMAC de um rótulo fixo sob a própria chave, truncado. Serve para saber **qual
 * chave cifrou cada linha** sem guardar nada secreto no banco e sem exigir que
 * alguém lembre de incrementar um número de versão a cada rotação — que é o tipo
 * de bookkeeping manual que falha justamente na rotação de emergência.
 *
 * Não permite recuperar a chave: é HMAC truncado de 8 bytes.
 */
function keyIdOf(key: Buffer): string {
  return createHmac('sha256', key).update(KEY_ID_LABEL).digest('hex').slice(0, 16);
}

/**
 * Cofre com chave atual e, opcionalmente, a anterior.
 *
 * Duas chaves ao mesmo tempo é o que torna a rotação possível **sem perder o
 * acervo**: cifra-se sempre com a atual, e a decifração tenta a atual e depois a
 * anterior. Sem isso, trocar a chave mestra tornaria ilegível todo PFX já
 * guardado — e não há recuperação, porque a senha do certificado não é guardada.
 *
 * A anterior existe só durante a janela de recifragem. Depois que
 * `scripts/recifrar-certificados.ts` confirma que nenhuma linha usa mais o id
 * antigo, ela sai do ambiente.
 */
export class CertificateVault {
  private readonly key: Buffer;
  private readonly previous: Buffer | null;

  constructor(masterKey: string, previousKey?: string) {
    this.key = deriveKey(masterKey);
    this.previous =
      previousKey === undefined || previousKey.trim() === '' ? null : deriveKey(previousKey);

    if (this.previous !== null && this.previous.equals(this.key)) {
      throw new CertificateError(
        'CERTIFICATE_MASTER_KEY_PREVIOUS é igual à atual. Ou a rotação não ' +
          'aconteceu, ou a variável ficou para trás — nos dois casos, remova-a.',
      );
    }
  }

  /** Id da chave que cifra agora. Vai para `certificates.key_id`. */
  get keyId(): string {
    return keyIdOf(this.key);
  }

  /** Id da chave anterior, quando há uma. */
  get previousKeyId(): string | null {
    return this.previous === null ? null : keyIdOf(this.previous);
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
      keyId: this.keyId,
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

    /**
     * Tenta a atual e depois a anterior.
     *
     * O GCM autentica, então uma chave errada falha na verificação do authTag em
     * vez de devolver bytes corrompidos — é o que torna esta tentativa segura:
     * não há como a chave errada "quase funcionar".
     */
    const comAtual = this.tentar(this.key, ivB64, tagB64, dataB64);
    if (comAtual !== null) {
      return comAtual;
    }

    if (this.previous !== null) {
      const comAnterior = this.tentar(this.previous, ivB64, tagB64, dataB64);
      if (comAnterior !== null) {
        return comAnterior;
      }
    }

    throw new CertificateError(
      'Falha ao decifrar o certificado: chave mestra incorreta ou dado adulterado.' +
        (this.previous === null
          ? ' Se a chave foi rotacionada, defina CERTIFICATE_MASTER_KEY_PREVIOUS.'
          : ''),
    );
  }

  private tentar(key: Buffer, ivB64: string, tagB64: string, dataB64: string): Buffer | null {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    try {
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    } catch {
      return null;
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
