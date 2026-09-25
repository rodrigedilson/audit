import nodemailer, { type Transporter } from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: readonly MailAttachment[];
}

/** Porta de envio. O SMTP é a implementação; os testes usam um dublê. */
export interface MailGateway {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/**
 * Envio por SMTP. Serve o servidor de e-mail do domínio próprio ou qualquer
 * serviço de envio que aceite SMTP, sem amarrar o produto a um fornecedor.
 *
 * O conteúdo é montado aqui, a partir de texto e `Buffer`: nada vem de caminho
 * de arquivo nem de URL. `disableFileAccess` e `disableUrlAccess` tornam isso
 * regra do transporte, e não só costume de quem chama.
 */
export class SmtpMailGateway implements MailGateway {
  private readonly transport: Transporter;

  /**
   * `transport` é a URL SMTP. Os testes passam as opções de um transporte que
   * não sai da máquina (`streamTransport`), para ler a mensagem montada.
   */
  constructor(
    transport: string | Record<string, unknown>,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(transport as string, {
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: (message.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return { messageId: String(info.messageId ?? '') };
  }
}
