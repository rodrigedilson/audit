import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ReadinessReport } from './readiness.js';

/**
 * Cifra do relatório do diagnóstico público, guardado por 24h até sair por
 * e-mail (AES-256-GCM, `iv:tag:dados` em base64).
 *
 * A chave é própria (`REPORT_ENCRYPTION_KEY`), e não a do cofre de
 * certificados: o relatório traz CNPJ e razão social de fornecedores do
 * visitante, e vazar uma chave não pode abrir o outro acervo.
 */
export class ReadinessReportCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Separação de domínio: a mesma string usada noutro lugar não daria a mesma chave.
    this.key = createHash('sha256').update(`readiness-report:${secret}`, 'utf8').digest();
  }

  encrypt(report: ReadinessReport): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const dados = Buffer.concat([cipher.update(JSON.stringify(report), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), dados].map((b) => b.toString('base64')).join(':');
  }

  decrypt(stored: string): ReadinessReport {
    const [iv, tag, dados] = stored.split(':');
    if (iv === undefined || tag === undefined || dados === undefined) {
      throw new Error('Relatório cifrado em formato desconhecido.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const claro = Buffer.concat([decipher.update(Buffer.from(dados, 'base64')), decipher.final()]);
    return JSON.parse(claro.toString('utf8')) as ReadinessReport;
  }
}
