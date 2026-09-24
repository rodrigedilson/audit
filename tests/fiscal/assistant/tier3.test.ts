import { describe, it, expect } from 'vitest';
import { montarResposta, type EvidenciaNumerada } from '../../../src/fiscal/assistant/tier3.js';
import { Evidence, assertGrounded, periodCitation, eventCitation } from '../../../src/fiscal/assistant/grounding.js';

const E1: EvidenciaNumerada = {
  id: 'E1',
  text: 'O ICMS devido na competência 2027-11 é R$ 180,00.',
  citations: [periodCitation('2027-11'), eventCitation(7, 'apuração')],
};
const E2: EvidenciaNumerada = { id: 'E2', text: 'Há 3 notas de entrada.', citations: [eventCitation(3, 'ingestão')] };
const EVIDENCIAS = [E1, E2];

const fato = (text: string, evidenceIds: string[]) => ({ kind: 'fact' as const, text, evidenceIds });

describe('montarResposta — camada 3', () => {
  it('fato com evidência válida recebe as citações reais dela', () => {
    const r = montarResposta({ answerable: true, reason: null, claims: [fato('O ICMS de 2027-11 é R$ 180,00.', ['E1'])] }, EVIDENCIAS);

    expect('answer' in r).toBe(true);
    if (!('answer' in r)) return;
    expect(r.answer).toMatchObject({ tier: 3, confidence: 'medium', answerable: true });
    expect(r.answer.claims[0]!.citations).toEqual(E1.citations);
  });

  /** A resposta montada passa pela mesma checagem das respostas determinísticas. */
  it('a resposta passa no assertGrounded contra as evidências reunidas', () => {
    const evidencia = new Evidence();
    E1.citations.forEach((c) => evidencia.add(c));
    const r = montarResposta({ answerable: true, reason: null, claims: [fato('O ICMS de 2027-11 é R$ 180,00.', ['E1'])] }, EVIDENCIAS);

    if (!('answer' in r)) throw new Error('esperava resposta');
    expect(() => assertGrounded(r.answer, evidencia)).not.toThrow();
  });

  it('juntar duas evidências junta as citações das duas', () => {
    const r = montarResposta(
      { answerable: true, reason: null, claims: [fato('R$ 180,00 de ICMS e 3 notas de entrada.', ['E1', 'E2'])] },
      EVIDENCIAS,
    );

    if (!('answer' in r)) throw new Error('esperava resposta');
    expect(r.answer.claims[0]!.citations).toHaveLength(3);
  });

  it.each([
    ['valor que não está na evidência', 'O ICMS é R$ 1.800,00.', ['E1'], /R\$ 1\.800,00/],
    ['valor que está em outra evidência, não na citada', 'São R$ 180,00.', ['E2'], /R\$ 180,00/],
    ['competência inventada', 'A competência 2027-12 está aberta.', ['E1'], /2027-12/],
    ['evidência inexistente', 'Tudo certo.', ['E9'], /inexistente/],
    ['fato sem evidência', 'Tudo certo.', [], /nenhuma/],
  ])('%s derruba a resposta', (_caso, texto, ids, motivo) => {
    const r = montarResposta({ answerable: true, reason: null, claims: [fato(texto, ids)] }, EVIDENCIAS);

    expect(r).toEqual({ rejeitada: expect.stringMatching(motivo) });
  });

  it('explicação passa sem citação', () => {
    const r = montarResposta(
      {
        answerable: true,
        reason: null,
        claims: [fato('O ICMS de 2027-11 é R$ 180,00.', ['E1']), { kind: 'explanation', text: 'O ICMS é estadual.', evidenceIds: [] }],
      },
      EVIDENCIAS,
    );

    if (!('answer' in r)) throw new Error('esperava resposta');
    expect(r.answer.claims[1]).toEqual({ kind: 'explanation', text: 'O ICMS é estadual.', citations: [] });
  });

  it('"não sei" do modelo sai com o motivo dele', () => {
    const r = montarResposta({ answerable: false, reason: 'Falta o extrato.', claims: [] }, EVIDENCIAS);

    if (!('answer' in r)) throw new Error('esperava resposta');
    expect(r.answer).toMatchObject({ answerable: false, unanswerableReason: 'Falta o extrato.' });
  });

  it('"não sei" sem motivo recebe um motivo, porque assertGrounded exige', () => {
    const r = montarResposta({ answerable: false, reason: null, claims: [] }, EVIDENCIAS);

    if (!('answer' in r)) throw new Error('esperava resposta');
    expect(r.answer.unanswerableReason).toBeTruthy();
  });
});
