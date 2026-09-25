import type { Citation } from '../assistant/grounding.js';
import { especieEsperada, type ForensicCase, type ForensicRole } from './case.js';

/**
 * A peça técnica, e o portão que impede o sistema de assinar.
 *
 * A norma técnica de perícia contábil reserva o trabalho pericial ao contador
 * com registro regular no conselho, e considera **leigo** qualquer outro
 * profissional. Disso decorre a regra que este módulo torna executável: o
 * sistema **nunca** emite peça assinada sem um signatário humano com registro
 * conferido.
 *
 * A regra não é uma checagem que alguém pode esquecer de chamar antes de
 * gravar. `SignedPiece` não existe sem `Signatory`, e `signatureBlockers` é
 * chamada em dois lugares pela mesma razão: a tela precisa saber o que falta
 * para desabilitar o botão, e a gravação precisa recusar.
 */

export const PIECE_KINDS = ['laudo', 'parecer', 'esclarecimentos'] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

export const PIECE_STATES = ['draft', 'signed', 'filed', 'superseded'] as const;
export type PieceState = (typeof PIECE_STATES)[number];

/**
 * Seções mínimas da peça, **na ordem da norma**.
 *
 * Array e não objeto: a ordem é a estrutura exigida, e um `Record` a perderia.
 */
export const PIECE_SECTIONS = [
  'identificacao_do_processo',
  'sintese_do_objeto',
  'resumo_dos_autos',
  'analise_tecnica',
  'metodo_e_fontes',
  'relato_das_diligencias',
  'quesitos_e_respostas',
  'conclusao',
  'termo_de_encerramento',
] as const;
export type PieceSection = (typeof PIECE_SECTIONS)[number];

/**
 * Signatário habilitado.
 *
 * `crcStatus` nasce `nao_verificado` e **bloqueia a assinatura**: não há
 * integração com o conselho, e presumir regularidade faria o sistema afirmar
 * uma habilitação que ninguém conferiu. A verificação é ato humano, com data
 * registrada.
 */
export interface Signatory {
  userId: string;
  fullName: string;
  /** Registro no conselho regional. */
  crc: string;
  crcState: string;
  crcStatus: 'regular' | 'irregular' | 'baixado' | 'nao_verificado';
  /** Inscrição no cadastro nacional de peritos. Exigida no laudo. */
  cnpc: string | null;
  verifiedAt: string | null;
}

export interface Quesito {
  quesitoId: string;
  origin: 'requerente' | 'requerida' | 'juizo' | 'ministerio_publico';
  ordinal: number;
  text: string;
  /** Resposta conclusiva. `null` enquanto não respondido. */
  answer: string | null;
  evidence: readonly Citation[];
  /** Quesito impertinente é recusado **com motivo**, nunca deixado em branco. */
  declined: { reason: string } | null;
}

export interface Piece {
  pieceId: string;
  caseId: string;
  kind: PieceKind;
  version: number;
  /** Aponta a anterior; a anterior nunca é alterada. */
  supersedes: string | null;
  state: PieceState;
  sections: Partial<Record<PieceSection, string>>;
  quesitoIds: readonly string[];
  /**
   * Denormalizado de propósito: a situação do registro **no momento da
   * assinatura** é o fato. Reler a situação atual do profissional depois
   * reescreveria a história de uma peça já entregue ao juízo.
   */
  signedBy: Signatory | null;
  signedAt: string | null;
  pdfSha256: string | null;
  /** Hash da projeção do CNPJ no instante da assinatura. */
  projectionHash: string | null;
}

export const SIGNATURE_BLOCKERS = [
  'signatario_ausente',
  'crc_nao_conferido',
  'crc_irregular',
  'cnpc_ausente_para_laudo',
  'papel_incompativel_com_a_especie',
  'secao_obrigatoria_vazia',
  'quesito_sem_resposta_conclusiva',
  'peca_ja_assinada',
] as const;
export type SignatureBlocker = (typeof SIGNATURE_BLOCKERS)[number];

export interface SignatureGateInput {
  piece: Piece;
  forensicCase: ForensicCase;
  quesitos: readonly Quesito[];
  signatory: Signatory | null;
}

/** Puro. Lista vazia significa que pode assinar. */
export function signatureBlockers(input: SignatureGateInput): SignatureBlocker[] {
  const { piece, forensicCase, quesitos, signatory } = input;
  const blockers: SignatureBlocker[] = [];

  if (piece.state !== 'draft') {
    blockers.push('peca_ja_assinada');
  }

  if (signatory === null) {
    blockers.push('signatario_ausente');
  } else {
    if (signatory.crcStatus === 'nao_verificado' || signatory.verifiedAt === null) {
      blockers.push('crc_nao_conferido');
    } else if (signatory.crcStatus !== 'regular') {
      blockers.push('crc_irregular');
    }

    // A inscrição no cadastro nacional de peritos é exigida na peça do perito
    // nomeado, e é o que o juízo confere primeiro.
    if (piece.kind === 'laudo' && (signatory.cnpc === null || signatory.cnpc.trim() === '')) {
      blockers.push('cnpc_ausente_para_laudo');
    }
  }

  if (piece.kind !== 'esclarecimentos' && piece.kind !== especieEsperada(forensicCase.role)) {
    blockers.push('papel_incompativel_com_a_especie');
  }

  const vazia = PIECE_SECTIONS.some(
    (s) => (piece.sections[s] ?? '').trim().length === 0,
  );
  if (vazia) {
    blockers.push('secao_obrigatoria_vazia');
  }

  // Quesito sem resposta e sem recusa fundamentada é lacuna, e a peça não sai
  // com lacuna: a parte contrária a usaria como impugnação.
  const daPeca = quesitos.filter((q) => piece.quesitoIds.includes(q.quesitoId));
  const pendente = daPeca.some(
    (q) => (q.answer === null || q.answer.trim() === '') && q.declined === null,
  );
  if (pendente) {
    blockers.push('quesito_sem_resposta_conclusiva');
  }

  return blockers;
}

export function canSign(input: SignatureGateInput): boolean {
  return signatureBlockers(input).length === 0;
}

/**
 * A peça assinada: o tipo não admite assinatura sem signatário.
 *
 * É a diferença entre uma regra que o compilador garante e uma que depende de
 * alguém lembrar de chamar a função certa antes do `insert`.
 */
export type SignedPiece = Piece & {
  state: 'signed' | 'filed';
  signedBy: Signatory;
  signedAt: string;
  pdfSha256: string;
  projectionHash: string;
};

export function isSigned(piece: Piece): piece is SignedPiece {
  return (
    (piece.state === 'signed' || piece.state === 'filed') &&
    piece.signedBy !== null &&
    piece.signedAt !== null &&
    piece.pdfSha256 !== null &&
    piece.projectionHash !== null
  );
}

/** Espécies que o papel autoriza. Esclarecimento acompanha a peça que corrige. */
export function especiesPermitidas(role: ForensicRole): readonly PieceKind[] {
  return [especieEsperada(role), 'esclarecimentos'];
}
