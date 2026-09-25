import { describe, expect, it } from 'vitest';

import {
  canSign,
  isSigned,
  especiesPermitidas,
  PIECE_SECTIONS,
  signatureBlockers,
  type Piece,
  type PieceKind,
  type Quesito,
  type Signatory,
} from '../../../src/fiscal/forensics/piece.js';
import {
  especieEsperada,
  isValidCaseTransition,
  isValidProcessNumber,
  type ForensicCase,
  type ForensicRole,
} from '../../../src/fiscal/forensics/case.js';

const secoesPreenchidas = (): Record<string, string> =>
  Object.fromEntries(PIECE_SECTIONS.map((s) => [s, `Conteúdo de ${s}.`]));

const signatario = (over: Partial<Signatory> = {}): Signatory => ({
  userId: '3f4a1c2e-0000-4000-8000-000000000001',
  fullName: 'Contadora Responsável',
  crc: 'SP 123456/O-1',
  crcState: 'SP',
  crcStatus: 'regular',
  cnpc: '12345',
  verifiedAt: '2027-01-10',
  ...over,
});

const caso = (over: Partial<ForensicCase> = {}): ForensicCase => ({
  caseId: 'c-1',
  processNumber: '10012345620278260100',
  court: 'TJSP',
  jurisdiction: '1ª Vara Cível',
  role: 'perito_nomeado',
  cnpj: '11222333000181',
  parties: [],
  retainedBy: null,
  state: 'peca_em_elaboracao',
  appointedAt: '2027-02-01',
  ...over,
});

const peca = (over: Partial<Piece> = {}): Piece => ({
  pieceId: 'p-1',
  caseId: 'c-1',
  kind: 'laudo',
  version: 1,
  supersedes: null,
  state: 'draft',
  sections: secoesPreenchidas(),
  quesitoIds: ['q-1'],
  signedBy: null,
  signedAt: null,
  pdfSha256: null,
  projectionHash: null,
  ...over,
});

const quesito = (over: Partial<Quesito> = {}): Quesito => ({
  quesitoId: 'q-1',
  origin: 'juizo',
  ordinal: 1,
  text: 'A apuração do período confere com os documentos?',
  answer: 'Sim, conforme a memória de cálculo anexa.',
  evidence: [],
  declined: null,
  ...over,
});

const gate = (over: Partial<Parameters<typeof signatureBlockers>[0]> = {}) =>
  signatureBlockers({
    piece: peca(),
    forensicCase: caso(),
    quesitos: [quesito()],
    signatory: signatario(),
    ...over,
  });

describe('portão de assinatura — o que o sistema nunca assina', () => {
  it('peça completa com signatário habilitado pode ser assinada', () => {
    expect(gate()).toEqual([]);
    expect(
      canSign({
        piece: peca(),
        forensicCase: caso(),
        quesitos: [quesito()],
        signatory: signatario(),
      }),
    ).toBe(true);
  });

  it('sem signatário não assina', () => {
    expect(gate({ signatory: null })).toContain('signatario_ausente');
  });

  /**
   * Presumir regularidade faria o sistema afirmar uma habilitação que ninguém
   * conferiu — e é a primeira coisa que a parte contrária ataca.
   */
  it('registro não conferido bloqueia, mesmo parecendo regular', () => {
    expect(gate({ signatory: signatario({ crcStatus: 'nao_verificado' }) })).toContain(
      'crc_nao_conferido',
    );
    expect(gate({ signatory: signatario({ verifiedAt: null }) })).toContain('crc_nao_conferido');
  });

  it.each(['irregular', 'baixado'] as const)('registro %s bloqueia', (status) => {
    expect(gate({ signatory: signatario({ crcStatus: status }) })).toContain('crc_irregular');
  });

  it('laudo sem inscrição no cadastro de peritos bloqueia', () => {
    expect(gate({ signatory: signatario({ cnpc: null }) })).toContain('cnpc_ausente_para_laudo');
    expect(gate({ signatory: signatario({ cnpc: '  ' }) })).toContain('cnpc_ausente_para_laudo');
  });

  it('parecer não exige a inscrição, porque não é peça de perito nomeado', () => {
    const blockers = gate({
      piece: peca({ kind: 'parecer' }),
      forensicCase: caso({ role: 'assistente_tecnico', retainedBy: 'requerente' }),
      signatory: signatario({ cnpc: null }),
    });

    expect(blockers).not.toContain('cnpc_ausente_para_laudo');
  });

  /**
   * O erro mais caro do módulo: entregar como imparcial algo produzido para
   * defender um lado.
   */
  it('assistente técnico não emite laudo', () => {
    expect(
      gate({ forensicCase: caso({ role: 'assistente_tecnico', retainedBy: 'requerente' }) }),
    ).toContain('papel_incompativel_com_a_especie');
  });

  it('perito nomeado não emite parecer', () => {
    expect(gate({ piece: peca({ kind: 'parecer' }) })).toContain(
      'papel_incompativel_com_a_especie',
    );
  });

  it('esclarecimentos é permitido nos dois papéis', () => {
    expect(gate({ piece: peca({ kind: 'esclarecimentos' }) })).not.toContain(
      'papel_incompativel_com_a_especie',
    );
  });

  it.each(PIECE_SECTIONS)('seção %s vazia bloqueia', (secao) => {
    const sections = { ...secoesPreenchidas(), [secao]: '   ' };

    expect(gate({ piece: peca({ sections }) })).toContain('secao_obrigatoria_vazia');
  });

  /** A peça não sai com lacuna: a parte contrária a usaria como impugnação. */
  it('quesito sem resposta bloqueia', () => {
    expect(gate({ quesitos: [quesito({ answer: null })] })).toContain(
      'quesito_sem_resposta_conclusiva',
    );
  });

  it('quesito recusado com motivo não bloqueia — recusar fundamentado é responder', () => {
    const recusado = quesito({ answer: null, declined: { reason: 'Impertinente ao objeto.' } });

    expect(gate({ quesitos: [recusado] })).not.toContain('quesito_sem_resposta_conclusiva');
  });

  it('quesito de outra peça não bloqueia esta', () => {
    const deOutra = quesito({ quesitoId: 'q-99', answer: null });

    expect(gate({ quesitos: [quesito(), deOutra] })).not.toContain(
      'quesito_sem_resposta_conclusiva',
    );
  });

  it('peça já assinada não é assinada de novo', () => {
    expect(gate({ piece: peca({ state: 'signed' }) })).toContain('peca_ja_assinada');
  });

  it('impedimentos se acumulam, para a tela listar tudo de uma vez', () => {
    const blockers = gate({
      piece: peca({ sections: {} }),
      signatory: null,
      quesitos: [quesito({ answer: null })],
    });

    expect(blockers).toEqual(
      expect.arrayContaining([
        'signatario_ausente',
        'secao_obrigatoria_vazia',
        'quesito_sem_resposta_conclusiva',
      ]),
    );
  });
});

describe('isSigned', () => {
  it('rascunho não é peça assinada', () => {
    expect(isSigned(peca())).toBe(false);
  });

  it('estado assinado sem os rastros não conta como assinada', () => {
    expect(isSigned(peca({ state: 'signed' }))).toBe(false);
  });

  it('assinada de verdade carrega signatário, hash do PDF e hash da projeção', () => {
    const assinada = peca({
      state: 'signed',
      signedBy: signatario(),
      signedAt: '2027-03-01T10:00:00Z',
      pdfSha256: 'a'.repeat(64),
      projectionHash: 'b'.repeat(64),
    });

    expect(isSigned(assinada)).toBe(true);
  });
});

describe('papel e espécie', () => {
  it.each<[ForensicRole, PieceKind]>([
    ['perito_nomeado', 'laudo'],
    ['assistente_tecnico', 'parecer'],
  ])('%s emite %s', (role, kind) => {
    expect(especieEsperada(role)).toBe(kind);
    expect(especiesPermitidas(role)).toContain(kind);
    expect(especiesPermitidas(role)).toContain('esclarecimentos');
  });
});

describe('caso pericial', () => {
  it('o número do processo é validado por formato, não por consulta ao tribunal', () => {
    expect(isValidProcessNumber('10012345620278260100')).toBe(true);
    expect(isValidProcessNumber('1001234562027826010')).toBe(false);
    expect(isValidProcessNumber('1001234562027826010A')).toBe(false);
  });

  it('nova diligência é autotransição, e não mudança de fase', () => {
    expect(isValidCaseTransition('diligencias_em_curso', 'diligencias_em_curso')).toBe(true);
  });

  it('peça entregue volta para elaboração — esclarecimento é a regra, não exceção', () => {
    expect(isValidCaseTransition('peca_entregue', 'peca_em_elaboracao')).toBe(true);
  });

  it('encerrado é terminal', () => {
    expect(isValidCaseTransition('encerrado', 'peca_em_elaboracao')).toBe(false);
  });
});
