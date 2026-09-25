import { describe, it, expect } from 'vitest';
import { SmtpMailGateway } from '../../../src/infrastructure/mail/mail-gateway.js';

describe('SmtpMailGateway', () => {
  it('monta a mensagem com remetente, destinatário e o PDF anexo', async () => {
    const gateway = new SmtpMailGateway({ streamTransport: true, buffer: true }, 'Diagnóstico <diagnostico@exemplo.com.br>');
    // O transporte de stream devolve a mensagem crua em `message`.
    const transporte = (gateway as unknown as { transport: { sendMail: (m: unknown) => Promise<{ message: Buffer }> } }).transport;
    const bruto = await transporte.sendMail({
      from: 'Diagnóstico <diagnostico@exemplo.com.br>',
      to: 'contador@escritorio.com.br',
      subject: 'x',
      text: 'corpo',
      attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }],
    });
    const texto = bruto.message.toString('utf8');

    expect(texto).toMatch(/To: contador@escritorio\.com\.br/);
    expect(texto).toMatch(/Content-Type: application\/pdf; name=a\.pdf/);
  });

  it('send devolve o id da mensagem', async () => {
    const gateway = new SmtpMailGateway({ streamTransport: true, buffer: true }, 'diagnostico@exemplo.com.br');

    const r = await gateway.send({
      to: 'contador@escritorio.com.br',
      subject: 'Diagnóstico',
      text: 'corpo',
      attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }],
    });

    expect(r.messageId).toMatch(/@/);
  });

  /** O conteúdo nunca vem de arquivo nem de URL: o transporte recusa, e não só quem chama evita. */
  it('recusa anexo lido de caminho de arquivo', async () => {
    const gateway = new SmtpMailGateway({ streamTransport: true, buffer: true }, 'diagnostico@exemplo.com.br');
    const transporte = (gateway as unknown as { transport: { sendMail: (m: unknown) => Promise<unknown> } }).transport;

    await expect(
      transporte.sendMail({ from: 'a@b.com', to: 'c@d.com', text: 'x', attachments: [{ path: '/etc/passwd' }] }),
    ).rejects.toThrow();
  });
});
