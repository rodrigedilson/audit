import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { IntegrityProof } from './integrity-proof.service.js';
import {
  AMBAR,
  CINZA,
  MARGEM,
  TEXTO,
  VERDE,
  VERMELHO,
  caixa,
  formatarCnpj,
  linhaDeDados,
  rodapes,
  secao,
} from './pdf-primitives.js';

/**
 * Comprovante de integridade em PDF: o mesmo `IntegrityProof` do JSON,
 * renderizado para o escritório entregar ao cliente. O hash vai **inteiro** no
 * rodapé de cada página — truncado, deixaria de ser verificável —, e o SHA-256
 * do próprio arquivo sai no cabeçalho `x-pdf-sha256` da resposta.
 */

export interface RenderedProof {
  pdf: Buffer;
  sha256: string;
}

const ESTADO: Record<string, string> = {
  open: 'aberta',
  assessed: 'apurada',
  reconciled: 'conciliada',
  confirmed: 'confirmada',
};

export async function renderIntegrityProofPdf(
  proof: IntegrityProof,
  quem: { tenantName: string; legalName: string },
): Promise<RenderedProof> {
  // O hash que o documento defende: o da confirmação, quando há; senão o de agora.
  const hash = proof.confirmed_hash ?? proof.stored_hash;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEM, bottom: MARGEM + 24, left: MARGEM, right: MARGEM },
    bufferPages: true,
    info: {
      Title: `Comprovante de integridade ${proof.cnpj} ${proof.period}`,
      Author: quem.tenantName,
      Keywords: hash,
    },
  });
  const pedacos: Buffer[] = [];
  doc.on('data', (p: Buffer) => pedacos.push(p));
  const finalizado = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
  });

  doc.fillColor(VERDE).fontSize(18).font('Helvetica-Bold').text('Comprovante de integridade');
  doc.moveDown(0.3);
  linhaDeDados(doc, [
    ['Empresa', `${quem.legalName} · ${formatarCnpj(proof.cnpj)}`],
    ['Competência', `${proof.period} (${ESTADO[proof.state] ?? proof.state})`],
    ['Escritório', quem.tenantName],
    ['Verificado em', new Date(proof.verified_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })],
  ]);

  secao(doc, 'Resultado');
  const [cor, veredito] = veredicto(proof);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(cor).text(veredito);
  doc.moveDown(0.4);
  doc.fontSize(9).font('Helvetica').fillColor(CINZA).text(explicacao(proof), { align: 'justify' });

  secao(doc, 'Hashes');
  caixa(doc, 'Hash da projeção agora (reprodução do log)', proof.replayed_hash);
  doc.moveDown(0.3);
  caixa(doc, 'Hash gravado', proof.stored_hash);
  if (proof.confirmed_hash !== null) {
    doc.moveDown(0.3);
    caixa(doc, 'Hash aprovado na confirmação', proof.confirmed_hash);
  }

  secao(doc, 'O que sustenta o número');
  linhaDeDados(doc, [
    ['Documentos de entrada', String(proof.documents.inbound)],
    ['Documentos de saída', String(proof.documents.outbound)],
    ['Canceladas na SEFAZ (fora das somas)', String(proof.documents.cancelled)],
    ['Eventos da competência', String(proof.events_in_period)],
    ['Eventos no log do CNPJ', `${proof.total_events} (último: ${proof.last_event_seq})`],
  ]);
  if (proof.confirmed_at !== null) {
    linhaDeDados(doc, [['Confirmada em', new Date(proof.confirmed_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })]]);
  }
  if (proof.rectified_by !== null) {
    linhaDeDados(doc, [['Retificada pela competência', proof.rectified_by]]);
  }
  if (proof.rectifies !== null) {
    linhaDeDados(doc, [['Retifica a competência', proof.rectifies]]);
  }

  doc.moveDown(1).fontSize(8).font('Helvetica').fillColor(TEXTO);
  doc.text(
    'Como conferir: o hash é o SHA-256 da projeção canônica do log de eventos do CNPJ (ADR-005). ' +
      'Refazer a projeção a partir do mesmo log produz o mesmo hash; qualquer evento alterado, ' +
      'removido ou acrescentado produz outro.',
    { align: 'justify' },
  );

  rodapes(doc, `${formatarCnpj(proof.cnpj)} · ${proof.period} · hash ${hash}`);
  doc.end();
  const pdf = await finalizado;
  return { pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
}

function veredicto(proof: IntegrityProof): [string, string] {
  if (!proof.ok) return [VERMELHO, 'A projeção não fecha com o log de eventos.'];
  if (proof.confirmed_hash_reproduced === false) {
    return [VERMELHO, 'O hash aprovado na confirmação não se reproduz a partir do log.'];
  }
  if (proof.confirmed_hash_reproduced === true) {
    return [VERDE, 'O número confirmado se reproduz a partir do log, e o log está íntegro.'];
  }
  return [AMBAR, 'O log está íntegro. A competência ainda não foi confirmada.'];
}

function explicacao(proof: IntegrityProof): string {
  if (!proof.ok) {
    return 'O comprovante é emitido mesmo assim, com o defeito à mostra: esconder a divergência seria o oposto do que ele existe para fazer.';
  }
  if (proof.confirmed_hash_reproduced === null) {
    return 'Competência não confirmada não tem hash aprovado a reproduzir. Não é falha nem pendência: é o estado de uma competência em trabalho.';
  }
  return 'O hash foi gravado no log no ato da confirmação. Reproduzi-lo exige refazer a projeção só com os eventos anteriores àquele instante: se algum tivesse sido alterado, removido ou acrescentado, o número não voltaria a bater.';
}
