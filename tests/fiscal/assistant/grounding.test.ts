import { describe, it, expect } from 'vitest';
import {
  assertGrounded,
  Evidence,
  UngroundedAnswerError,
  fact,
  explanation,
  eventCitation,
  documentCitation,
  lineCitation,
  divergenceCitation,
  itemCitation,
  periodCitation,
  type Answer,
} from '../../../src/fiscal/assistant/grounding.js';

const CHAVE = '35270912345678000195550010000000011234567893';

function resposta(override: Partial<Answer> = {}): Answer {
  return {
    intent: 'estado_da_competencia',
    tier: 1,
    confidence: 'high',
    answerable: true,
    claims: [],
    suggested: [],
    ...override,
  };
}

describe('ancoragem — toda afirmação factual carrega citação', () => {
  it('aprova a afirmação citando evidência recuperada', () => {
    const evidencia = new Evidence();
    const citacao = evidencia.add(eventCitation(42, 'assessment.projected'));

    expect(() =>
      assertGrounded(
        resposta({ claims: [fact('A competência foi apurada.', [citacao])] }),
        evidencia,
      ),
    ).not.toThrow();
  });

  it('recusa afirmação factual sem citação nenhuma', () => {
    expect(() =>
      assertGrounded(resposta({ claims: [fact('Você deve R$ 14.800,00.', [])] }), new Evidence()),
    ).toThrow(/sem citação/);
  });

  /**
   * A garantia central: é mecânica, não uma instrução de prompt. Mesmo que a
   * resposta venha de um modelo de linguagem, citação que não veio da consulta
   * não escapa.
   */
  it('recusa citação que não está nas evidências recuperadas', () => {
    const evidencia = new Evidence();
    evidencia.add(eventCitation(42, 'real'));

    expect(() =>
      assertGrounded(
        resposta({ claims: [fact('Aconteceu isso.', [eventCitation(999, 'inventado')])] }),
        evidencia,
      ),
    ).toThrow(/citação inventada/);
  });

  it('a citação inventada é identificada na mensagem de erro', () => {
    try {
      assertGrounded(
        resposta({ claims: [fact('Nota X entrou.', [documentCitation(CHAVE)])] }),
        new Evidence(),
      );
      expect.unreachable('deveria ter recusado');
    } catch (causa) {
      expect(causa).toBeInstanceOf(UngroundedAnswerError);
      expect((causa as Error).message).toContain(`document:${CHAVE}`);
    }
  });

  it('uma citação boa não cobre outra ruim na mesma afirmação', () => {
    const evidencia = new Evidence();
    const boa = evidencia.add(eventCitation(1, 'ok'));

    expect(() =>
      assertGrounded(
        resposta({ claims: [fact('Duas coisas.', [boa, eventCitation(2, 'falsa')])] }),
        evidencia,
      ),
    ).toThrow(/fora das evidências/);
  });

  describe('identidade da citação', () => {
    it('linha de apuração distingue chave, item e tributo', () => {
      const evidencia = new Evidence();
      evidencia.add(lineCitation(CHAVE, 1, 'icms'));

      expect(evidencia.has(lineCitation(CHAVE, 1, 'icms'))).toBe(true);
      expect(evidencia.has(lineCitation(CHAVE, 2, 'icms'))).toBe(false);
      expect(evidencia.has(lineCitation(CHAVE, 1, 'cbs'))).toBe(false);
    });

    it('cada tipo de citação tem espaço próprio', () => {
      const evidencia = new Evidence();
      evidencia.add(periodCitation('2027-09'));

      expect(evidencia.has(divergenceCitation('2027-09', 'icms'))).toBe(false);
      expect(evidencia.has(itemCitation('2027-09'))).toBe(false);
    });

    it('o rótulo não faz parte da identidade de um evento', () => {
      const evidencia = new Evidence();
      evidencia.add(eventCitation(7, 'rótulo de um jeito'));

      expect(evidencia.has(eventCitation(7, 'rótulo de outro'))).toBe(true);
    });
  });

  describe('explicação não pode contrabandear fato', () => {
    it('aceita texto normativo sem citação', () => {
      expect(() =>
        assertGrounded(
          resposta({
            claims: [
              fact('Apurada.', [new Evidence().add(eventCitation(1, 'x'))]),
              explanation(
                'Sem regra de creditamento publicada, o valor devido não é calculado.',
              ),
            ],
          }),
          (() => {
            const e = new Evidence();
            e.add(eventCitation(1, 'x'));
            return e;
          })(),
        ),
      ).not.toThrow();
    });

    /**
     * Escrever um valor numa explicação seria contrabandear afirmação factual
     * para fora da regra de citação — a brecha mais fácil de abrir sem perceber.
     */
    it('recusa explicação com valor monetário', () => {
      expect(() =>
        assertGrounded(
          resposta({ claims: [explanation('O devido do mês é R$ 14.800,00.')] }),
          new Evidence(),
        ),
      ).toThrow(/valor monetário/);
    });

    it('recusa explicação referenciando uma competência do cliente', () => {
      expect(() =>
        assertGrounded(
          resposta({ claims: [explanation('A competência 2027-09 está aberta.')] }),
          new Evidence(),
        ),
      ).toThrow(/competência/);
    });

    /** "camada 3" e "7 camadas" são estrutura do produto, não dado do cliente. */
    it('aceita número estrutural na explicação', () => {
      const evidencia = new Evidence();
      const c = evidencia.add(eventCitation(1, 'x'));

      expect(() =>
        assertGrounded(
          resposta({
            claims: [
              fact('Rejeitado.', [c]),
              explanation('A recusa aconteceu na camada 3 das 7 do pipeline.'),
            ],
          }),
          evidencia,
        ),
      ).not.toThrow();
    });
  });

  describe('não respondível', () => {
    /** "Não sei" sem o porquê é indistinguível de falha silenciosa. */
    it('exige o motivo declarado', () => {
      expect(() =>
        assertGrounded(resposta({ answerable: false, claims: [] }), new Evidence()),
      ).toThrow(/sem motivo declarado/);
    });

    it('motivo em branco não conta como motivo', () => {
      expect(() =>
        assertGrounded(
          resposta({ answerable: false, unanswerableReason: '   ' }),
          new Evidence(),
        ),
      ).toThrow(/sem motivo declarado/);
    });

    it('aceita não respondível com motivo e sem afirmação nenhuma', () => {
      expect(() =>
        assertGrounded(
          resposta({
            answerable: false,
            unanswerableReason: 'A competência não foi apurada.',
          }),
          new Evidence(),
        ),
      ).not.toThrow();
    });

    /** A evidência que ela trouxe segue valendo a mesma regra. */
    it('não respondível com citação inventada ainda é recusada', () => {
      expect(() =>
        assertGrounded(
          resposta({
            answerable: false,
            unanswerableReason: 'Não sei.',
            claims: [fact('Mas olha isso.', [eventCitation(1, 'falsa')])],
          }),
          new Evidence(),
        ),
      ).toThrow(/fora das evidências/);
    });
  });

  /**
   * Responder só com explicação normativa a uma pergunta sobre o cliente é
   * exatamente o comportamento do assistente genérico que o briefing manda
   * evitar: parece resposta e não diz nada sobre este CNPJ.
   */
  it('recusa resposta respondível feita só de explicação', () => {
    expect(() =>
      assertGrounded(
        resposta({ claims: [explanation('A apuração dual compara os dois sistemas.')] }),
        new Evidence(),
      ),
    ).toThrow(/só explicação não responde/);
  });

  it('resposta respondível sem afirmação nenhuma também é recusada', () => {
    expect(() => assertGrounded(resposta({ claims: [] }), new Evidence())).toThrow(
      /só explicação não responde/,
    );
  });
});
