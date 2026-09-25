import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { DocumentTextError, detectKind, extractDocumentText } from '../../../../src/fiscal/forensics/capag/document-text.js';

async function pdf(linhas: string[]): Promise<Uint8Array> {
  const doc = new PDFDocument();
  const partes: Buffer[] = [];
  doc.on('data', (p: Buffer) => partes.push(p));
  const fim = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(partes))));
  for (const l of linhas) doc.text(l);
  doc.end();
  return new Uint8Array(await fim);
}

describe('extractDocumentText', () => {
  it('lê o texto de um PDF, com acentos e valores como impressos', async () => {
    const r = await extractDocumentText(
      await pdf(['Capacidade de Pagamento Presumida', 'V1 - Receita bruta: R$ 1.234.567,89', 'Classificação: C']),
      'application/pdf',
    );

    expect(r.kind).toBe('pdf');
    expect(r.pages).toBe(1);
    expect(r.text).toContain('R$ 1.234.567,89');
    expect(r.text).toContain('Classificação: C');
  });

  it('recusa PDF sem texto (digitalizado), dizendo o que fazer', async () => {
    await expect(extractDocumentText(await pdf(['']), 'application/pdf')).rejects.toThrow(/digitalizado/);
  });

  it('HTML vira texto corrido', async () => {
    const html = '<html><body><table><tr><td>CAPAG</td><td>R$ 98.765,43</td></tr></table>' +
      '<p>Capacidade de pagamento presumida do contribuinte, apurada pela PGFN.</p></body></html>';
    const r = await extractDocumentText(new TextEncoder().encode(html), 'text/html');

    expect(r.kind).toBe('html');
    expect(r.text).toContain('CAPAG R$ 98.765,43');
  });

  it('reconhece PDF pelos bytes, mesmo sem content-type', () => {
    expect(detectKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), null)).toBe('pdf');
    expect(detectKind(new TextEncoder().encode('<!DOCTYPE html><html>'), null)).toBe('html');
  });

  it('PDF corrompido é erro com motivo', async () => {
    await expect(
      extractDocumentText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00]), null),
    ).rejects.toThrow(DocumentTextError);
  });
});
