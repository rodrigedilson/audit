import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { MailGateway } from '../../infrastructure/mail/mail-gateway.js';
import { renderReadinessPdf } from '../reporting/readiness-pdf.js';
import type { ReadinessReportCipher } from './readiness-cipher.js';
import type { ReadinessReport } from './readiness.js';

/**
 * Entrega do relatório do diagnóstico público por e-mail.
 *
 * O relatório fica cifrado por no máximo 24h, e sai de três jeitos: enviado
 * (apagado na hora), vencido (apagado pela purga) ou esquecido a pedido. O
 * e-mail leva um link que apaga o endereço e o consentimento — o visitante não
 * precisa escrever para ninguém para exercer o direito (LGPD, art. 18).
 */

export const VALIDADE_DO_RELATORIO_H = 24;

export type DeliveryOutcome =
  | { sent: true }
  | { sent: false; reason: 'mail_not_configured' | 'report_not_available' | 'send_failed' };

export type ReportAvailability = 'available' | 'expired' | 'not_found';

export interface ReadinessDeliveryDeps {
  pool: Pool;
  cipher?: ReadinessReportCipher;
  mail?: MailGateway;
  /** Base pública da API, para o link de remoção. */
  publicApiUrl?: string;
  now?: () => Date;
}

export class ReadinessDelivery {
  private readonly now: () => Date;

  constructor(private readonly deps: ReadinessDeliveryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Há como enviar: chave do relatório, SMTP e a URL do link de remoção. */
  get enabled(): boolean {
    return this.deps.cipher !== undefined && this.deps.mail !== undefined && this.deps.publicApiUrl !== undefined;
  }

  /** Guarda o relatório cifrado, quando há chave. Sem chave, nada é guardado. */
  async store(reportId: string, report: ReadinessReport): Promise<Date | null> {
    if (this.deps.cipher === undefined) return null;
    const expira = new Date(this.now().getTime() + VALIDADE_DO_RELATORIO_H * 3600_000);
    await this.deps.pool.query(
      `update readiness_reports set report_ciphertext = $2, report_expires_at = $3::timestamptz
        where id = $1::uuid`,
      [reportId, this.deps.cipher.encrypt(report), expira],
    );
    return expira;
  }

  /** Relatório disponível para envio, vencido, ou diagnóstico inexistente ou já com lead. */
  async availability(reportId: string): Promise<ReportAvailability> {
    const { rows } = await this.deps.pool.query<{ email: string | null; disponivel: boolean }>(
      `select email, (report_ciphertext is not null and report_expires_at > $2::timestamptz) as disponivel
         from readiness_reports where id = $1::uuid`,
      [reportId, this.now()],
    );
    const linha = rows[0];
    if (linha === undefined || linha.email !== null) return 'not_found';
    return linha.disponivel ? 'available' : 'expired';
  }

  /**
   * Envia o relatório ao e-mail já consentido do diagnóstico. O token do link
   * de remoção é gravado (só o hash) antes do envio: o link precisa funcionar a
   * partir do instante em que o e-mail chega.
   */
  async send(reportId: string): Promise<DeliveryOutcome> {
    const { cipher, mail, publicApiUrl, pool } = this.deps;
    if (cipher === undefined || mail === undefined || publicApiUrl === undefined) {
      return { sent: false, reason: 'mail_not_configured' };
    }

    const { rows } = await pool.query<{ email: string | null; report_ciphertext: string | null }>(
      `select email, report_ciphertext from readiness_reports
        where id = $1::uuid and report_expires_at > $2::timestamptz`,
      [reportId, this.now()],
    );
    const linha = rows[0];
    if (linha?.email == null || linha.report_ciphertext === null) {
      return { sent: false, reason: 'report_not_available' };
    }

    const token = randomBytes(32).toString('base64url');
    await pool.query('update readiness_reports set forget_token_hash = $2 where id = $1::uuid', [
      reportId,
      hashDoToken(token),
    ]);

    try {
      const pdf = await renderReadinessPdf(cipher.decrypt(linha.report_ciphertext), this.now());
      await mail.send({
        to: linha.email,
        subject: 'Seu diagnóstico de prontidão para a reforma tributária',
        text: corpoDoEmail(`${publicApiUrl}/v1/reform-readiness/forget?token=${token}`),
        attachments: [{ filename: 'diagnostico-reforma.pdf', content: pdf, contentType: 'application/pdf' }],
      });
    } catch (erro) {
      await pool.query('update readiness_reports set email_error = $2 where id = $1::uuid', [
        reportId,
        (erro instanceof Error ? erro.message : String(erro)).slice(0, 500),
      ]);
      return { sent: false, reason: 'send_failed' };
    }

    // Enviado, o relatório não tem mais razão de existir aqui.
    await pool.query(
      `update readiness_reports
          set email_sent_at = now(), email_error = null, report_ciphertext = null, report_expires_at = null
        where id = $1::uuid`,
      [reportId],
    );
    return { sent: true };
  }

  /** Apaga e-mail, consentimento e relatório do diagnóstico do token. Falso se o link não vale. */
  async forget(token: string): Promise<boolean> {
    const r = await this.deps.pool.query(
      `update readiness_reports
          set email = null, email_consent_at = null, source = null,
              report_ciphertext = null, report_expires_at = null, forget_token_hash = null
        where forget_token_hash = $1`,
      [hashDoToken(token)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Apaga os relatórios vencidos. Roda a cada diagnóstico: é barata, e não depende de worker. */
  async purgeExpired(): Promise<number> {
    // Sem chave nada é guardado, e não há o que purgar. Também deixa o
    // diagnóstico funcionar num banco em que a migration do envio ainda não rodou.
    if (this.deps.cipher === undefined) return 0;
    const r = await this.deps.pool.query(
      `update readiness_reports set report_ciphertext = null, report_expires_at = null
        where report_ciphertext is not null and report_expires_at <= $1::timestamptz`,
      [this.now()],
    );
    return r.rowCount ?? 0;
  }
}

function hashDoToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function corpoDoEmail(linkDeRemocao: string): string {
  return [
    'Olá,',
    '',
    'Segue em anexo o diagnóstico de prontidão para a reforma tributária que você gerou no nosso site.',
    'Ele mostra quantos dos seus fornecedores já emitem NF-e com o grupo de IBS/CBS.',
    '',
    'Os XMLs que você enviou não foram guardados, e o resumo usado para montar este relatório foi',
    'apagado assim que este e-mail saiu.',
    '',
    'Você recebeu esta mensagem porque pediu o envio e consentiu com o registro do seu e-mail.',
    `Para apagar o seu e-mail da nossa base, abra: ${linkDeRemocao}`,
  ].join('\n');
}
