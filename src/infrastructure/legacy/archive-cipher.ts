import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Cifra do arquivo do acervo legado.
 *
 * O arquivo é dado fiscal sigiloso de clientes reais (art. 198 do CTN) e vai
 * ficar fora do banco, numa máquina ou num disco. Por isso:
 *
 * - **AES-256-GCM**: cifra autenticada. Um byte trocado no arquivo faz a
 *   decifra falhar, em vez de devolver dado errado.
 * - **Chave derivada da senha por scrypt** (N = 2^17), com sal aleatório por
 *   arquivo. A senha é de quem guarda o arquivo e nunca é gravada: nem aqui,
 *   nem no Doppler, nem no repositório.
 * - **Cabeçalho autenticado**: a versão e os parâmetros entram como dado
 *   associado, e não dá para trocá-los sem a decifra perceber.
 *
 * Formato: `AUDLEG1\n` · sal (16) · IV (12) · texto cifrado · tag (16).
 */

const MAGICA = Buffer.from('AUDLEG1\n', 'utf8');
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
export const SENHA_MINIMA = 16;

export class ArchiveCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveCipherError';
  }
}

function chave(senha: string, sal: Buffer): Buffer {
  if (senha.length < SENHA_MINIMA) {
    throw new ArchiveCipherError(`A senha precisa de ao menos ${SENHA_MINIMA} caracteres.`);
  }
  return scryptSync(senha, sal, 32, SCRYPT);
}

export function cifrar(conteudo: string, senha: string): Buffer {
  const sal = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chave(senha, sal), iv);
  cipher.setAAD(Buffer.concat([MAGICA, sal, iv]));
  const cifrado = Buffer.concat([cipher.update(gzipSync(Buffer.from(conteudo, 'utf8'))), cipher.final()]);
  return Buffer.concat([MAGICA, sal, iv, cifrado, cipher.getAuthTag()]);
}

export function decifrar(arquivo: Buffer, senha: string): string {
  if (arquivo.length < MAGICA.length + 16 + 12 + 16 || !arquivo.subarray(0, MAGICA.length).equals(MAGICA)) {
    throw new ArchiveCipherError('Não é um arquivo do acervo legado (cabeçalho AUDLEG1 ausente).');
  }
  const sal = arquivo.subarray(MAGICA.length, MAGICA.length + 16);
  const iv = arquivo.subarray(MAGICA.length + 16, MAGICA.length + 28);
  const tag = arquivo.subarray(arquivo.length - 16);
  const cifrado = arquivo.subarray(MAGICA.length + 28, arquivo.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', chave(senha, sal), iv);
  decipher.setAAD(Buffer.concat([MAGICA, sal, iv]));
  decipher.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([decipher.update(cifrado), decipher.final()])).toString('utf8');
  } catch {
    throw new ArchiveCipherError('Senha errada, ou o arquivo foi alterado: a decifra autenticada recusou.');
  }
}
