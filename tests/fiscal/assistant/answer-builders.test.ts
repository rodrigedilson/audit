import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  documentos,
  estadoDaCompetencia,
  porQueNaoDeterminavel,
  valorDevido,
} from '../../../src/fiscal/assistant/answers/assessment.js';
import { historico, saudeDoCadastro } from '../../../src/fiscal/assistant/answers/audit.js';
import {
  assertGrounded,
  Evidence,
  type Answer,
} from '../../../src/fiscal/assistant/grounding.js';
import { EventScope } from '../../../src/esaa/core/event-store/value-objects/event-scope.vo.js';

const SCOPE = EventScope.create('11111111-1111-1111-1111-111111111111', '12345678000195');
const PERIODO = '2027-09';
const CHAVE = '35270912345678000195550010000000011234567893';

/**
 * Pool falso que devolve os resultados na ordem em que forem pedidos.
 *
 * Por ordem de chamada, e não por texto de SQL: casar por trecho de consulta
 * faria o teste quebrar ao reescrever a query sem mudar comportamento nenhum.
 */
function poolDeFila(...resultados: Record<string, unknown>[][]): Pool {
  const fila = [...resultados];
  return {
    query: async () => ({ rows: fila.shift() ?? [] }),
  } as unknown as Pool;
}

/**
 * Toda resposta construída aqui passa pela mesma checagem da borda: é o que
 * garante que os construtores registram a evidência antes de citá-la.
 */
async function ancorada(
  construir: (evidencia: Evidence) => Promise<Answer>,
): Promise<Answer> {
  const evidencia = new Evidence();
  const answer = await construir(evidencia);
  assertGrounded(answer, evidencia);
  return answer;
}

/**
 * Junta os textos e normaliza o espaço inseparável (U+00A0) que o `Intl` pt-BR
 * põe entre `R$` e o valor. Sem isso, cada literal de moeda no teste teria de
 * carregar o caractere invisível.
 */
const textos = (answer: Answer): string =>
  answer.claims
    .map((c) => c.text)
    .join(' | ')
    .replace(/\u00a0/g, ' ');

describe('construtores de resposta — competência e apuração', () => {
  describe('estado da competência', () => {
    it.each([
      ['open', 'aberta', 'assessment.projected'],
      ['assessed', 'apurada', 'assessment.compared'],
      ['reconciled', 'conciliada', 'assessment.confirmed'],
      ['confirmed', 'confirmada e fechada', 'consulta'],
    ] as const)('estado %s é traduzido e sugere o passo seguinte', async (estado, rotulo, acao) => {
      const answer = await ancorada((e) =>
        estadoDaCompetencia(
          poolDeFila([{ state: estado, projection_hash: 'abc', ultimo_seq: '7' }]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(textos(answer)).toContain(rotulo);
      expect(answer.suggested[0]!.action).toBe(acao);
    });

    /** Competência sem nenhum evento ainda: a citação do último evento não existe. */
    it('cita só a competência quando o log do mês está vazio', async () => {
      const answer = await ancorada((e) =>
        estadoDaCompetencia(
          poolDeFila([{ state: 'open', projection_hash: null, ultimo_seq: null }]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(answer.claims[0]!.citations).toHaveLength(1);
      expect(answer.claims[0]!.citations[0]!.kind).toBe('period');
    });

    it('competência não aberta não recebe estado inventado', async () => {
      const answer = await ancorada((e) =>
        estadoDaCompetencia(poolDeFila([]), SCOPE, PERIODO, 1, e),
      );

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/não foi aberta/);
    });

    /** Fechada é terminal: a explicação tem de dizer que a saída é retificação. */
    it('competência confirmada explica que a correção é por retificação', async () => {
      const answer = await ancorada((e) =>
        estadoDaCompetencia(
          poolDeFila([{ state: 'confirmed', projection_hash: 'h', ultimo_seq: '9' }]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(textos(answer)).toMatch(/retificação/);
      expect(textos(answer)).toMatch(/preserva o hash original/);
    });
  });

  describe('valor devido', () => {
    const totais = (over: Record<string, unknown> = {}) => [
      {
        totals: {
          icms: {
            debitsCents: 1_800_000,
            potentialCreditsCents: 320_000,
            creditableCents: 320_000,
            dueCents: 1_480_000,
          },
          cbs: {
            debitsCents: 921_000,
            potentialCreditsCents: 0,
            creditableCents: null,
            dueCents: null,
          },
          ipi: {
            debitsCents: 0,
            potentialCreditsCents: 0,
            creditableCents: 0,
            dueCents: 0,
          },
        },
        event_seq: '4',
        ...over,
      },
    ];

    it('afirma cada tributo com movimento, em reais', async () => {
      const answer = await ancorada((e) =>
        valorDevido(poolDeFila(totais()), SCOPE, PERIODO, undefined, 1, e),
      );

      expect(textos(answer)).toContain('R$ 18.000,00');
      expect(textos(answer)).toContain('ICMS');
      expect(textos(answer)).toContain('CBS');
    });

    /** Tributo sem movimento não é resposta: seria linha de zero para ler. */
    it('omite tributo sem débito nem crédito', async () => {
      const answer = await ancorada((e) =>
        valorDevido(poolDeFila(totais()), SCOPE, PERIODO, undefined, 1, e),
      );

      expect(textos(answer)).not.toContain('IPI');
    });

    it('filtra por tributo quando a pergunta nomeia um', async () => {
      const answer = await ancorada((e) =>
        valorDevido(poolDeFila(totais()), SCOPE, PERIODO, 'cbs', 1, e),
      );

      expect(textos(answer)).toContain('CBS');
      expect(textos(answer)).not.toContain('ICMS');
    });

    /**
     * Confiança alta faria o contador tratar como fechada uma resposta que está
     * certa e incompleta.
     */
    it('devido nulo baixa a confiança e explica o motivo', async () => {
      const answer = await ancorada((e) =>
        valorDevido(poolDeFila(totais()), SCOPE, PERIODO, undefined, 1, e),
      );

      expect(answer.confidence).toBe('medium');
      expect(textos(answer)).toContain('não determinável');
      expect(textos(answer)).toMatch(/pior do que um ausente/);
    });

    it('todos os devidos calculados dão confiança alta e nenhuma ressalva', async () => {
      const answer = await ancorada((e) =>
        valorDevido(
          poolDeFila([
            {
              totals: {
                icms: {
                  debitsCents: 100,
                  potentialCreditsCents: 0,
                  creditableCents: 0,
                  dueCents: 100,
                },
              },
              event_seq: '4',
            },
          ]),
          SCOPE,
          PERIODO,
          undefined,
          1,
          e,
        ),
      );

      expect(answer.confidence).toBe('high');
      expect(answer.suggested).toHaveLength(0);
    });

    it('sem apuração, sugere apurar em vez de responder zero', async () => {
      const answer = await ancorada((e) =>
        valorDevido(poolDeFila([]), SCOPE, PERIODO, undefined, 1, e),
      );

      expect(answer.answerable).toBe(false);
      expect(answer.suggested[0]!.action).toBe('assessment.projected');
    });

    it('tributo pedido sem movimento diz isso, nomeando o tributo', async () => {
      const answer = await ancorada((e) =>
        valorDevido(poolDeFila(totais()), SCOPE, PERIODO, 'ipi', 1, e),
      );

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toContain('IPI');
    });

    it('nenhum tributo destacado é dito sem nomear tributo', async () => {
      const answer = await ancorada((e) =>
        valorDevido(
          poolDeFila([{ totals: {}, event_seq: '4' }]),
          SCOPE,
          PERIODO,
          undefined,
          1,
          e,
        ),
      );

      expect(answer.unanswerableReason).toMatch(/Nenhum tributo foi destacado/);
    });
  });

  describe('por que não determinável', () => {
    /** Dez itens sem grupo UB são um achado, não dez linhas para ler. */
    it('agrupa por motivo e amostra os primeiros', async () => {
      const answer = await ancorada((e) =>
        porQueNaoDeterminavel(
          poolDeFila([
            {
              not_computable: Array.from({ length: 8 }, (_, i) => ({
                subject: `item-${i}`,
                reason: 'missing_reform_group',
                message: 'Item não traz o grupo IBS/CBS.',
              })),
              event_seq: '4',
            },
          ]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(answer.claims).toHaveLength(1);
      expect(textos(answer)).toContain('8 ocorrência(s)');
      expect(textos(answer)).toContain('e outros 3');
    });

    it('separa motivos diferentes em afirmações diferentes', async () => {
      const answer = await ancorada((e) =>
        porQueNaoDeterminavel(
          poolDeFila([
            {
              not_computable: [
                { subject: 'icms', reason: 'rule_not_published', message: 'Sem regra.' },
                { subject: 'item-1', reason: 'missing_reform_group', message: 'Sem grupo.' },
              ],
              event_seq: '4',
            },
          ]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(answer.claims).toHaveLength(2);
    });

    it('nada indeterminado é dito como tal, não como lista vazia', async () => {
      const answer = await ancorada((e) =>
        porQueNaoDeterminavel(
          poolDeFila([{ not_computable: [], event_seq: '4' }]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/Nenhum valor/);
    });

    it('`not_computable` nulo no banco não quebra a resposta', async () => {
      const answer = await ancorada((e) =>
        porQueNaoDeterminavel(
          poolDeFila([{ not_computable: null, event_seq: '4' }]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(answer.answerable).toBe(false);
    });

    it('sem apuração, não há indeterminado para explicar', async () => {
      const answer = await ancorada((e) =>
        porQueNaoDeterminavel(poolDeFila([]), SCOPE, PERIODO, 1, e),
      );

      expect(answer.unanswerableReason).toMatch(/não foi apurada/);
    });
  });

  describe('documentos da competência', () => {
    it('separa entrada de saída, com valor somado', async () => {
      const answer = await ancorada((e) =>
        documentos(
          poolDeFila([
            { direction: 'outbound', total: '12', valor: '1200000' },
            { direction: 'inbound', total: '30', valor: '4500000' },
          ]),
          SCOPE,
          PERIODO,
          1,
          e,
        ),
      );

      expect(textos(answer)).toContain('12 documento(s) de saída');
      expect(textos(answer)).toContain('30 documento(s) de entrada');
      expect(textos(answer)).toContain('R$ 12.000,00');
    });

    it('nenhum documento sugere ingerir', async () => {
      const answer = await ancorada((e) => documentos(poolDeFila([]), SCOPE, PERIODO, 1, e));

      expect(answer.answerable).toBe(false);
      expect(answer.suggested[0]!.action).toBe('doc.received');
    });
  });
});

describe('construtores de resposta — auditoria', () => {
  describe('saúde do cadastro', () => {
    it('afirma item por item, com a propagação e o valor', async () => {
      const answer = await ancorada((e) =>
        saudeDoCadastro(
          poolDeFila([
            {
              item_id: 'SKU-1',
              health: 'error',
              documentos: '12',
              valor: '4500000',
              mensagem: 'cClassTrib incompatível com o CST.',
            },
          ]),
          SCOPE,
          1,
          e,
        ),
      );

      expect(textos(answer)).toContain('SKU-1');
      expect(textos(answer)).toContain('12 documento(s)');
      expect(textos(answer)).toContain('R$ 45.000,00');
      expect(answer.claims[0]!.citations[0]!.kind).toBe('item');
    });

    it('item sem mensagem registrada não inventa motivo', async () => {
      const answer = await ancorada((e) =>
        saudeDoCadastro(
          poolDeFila([
            { item_id: 'SKU-2', health: 'warning', documentos: '0', valor: '0', mensagem: null },
          ]),
          SCOPE,
          1,
          e,
        ),
      );

      expect(textos(answer)).toContain('Sem mensagem registrada');
    });

    /**
     * Cadastro sem inconsistência e cadastro não classificado são coisas
     * diferentes, e a resposta tem de dizer qual é qual.
     */
    it('nenhuma inconsistência não é confundida com cadastro conferido', async () => {
      const answer = await ancorada((e) => saudeDoCadastro(poolDeFila([]), SCOPE, 1, e));

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/não é o mesmo que estar correto/);
    });

    it('explica que a contagem é de notas já emitidas', async () => {
      const answer = await ancorada((e) =>
        saudeDoCadastro(
          poolDeFila([
            { item_id: 'SKU-1', health: 'error', documentos: '5', valor: '100', mensagem: 'x' },
          ]),
          SCOPE,
          1,
          e,
        ),
      );

      expect(textos(answer)).toMatch(/olham um XML por vez/);
    });
  });

  describe('histórico do documento', () => {
    it('uma afirmação por evento, cada uma citando o seu event_seq', async () => {
      const answer = await ancorada((e) =>
        historico(
          poolDeFila([
            {
              event_seq: '1',
              action: 'doc.received',
              actor: 'ana',
              ts: '2027-09-15T10:00:00Z',
              payload: {},
            },
            {
              event_seq: '4',
              action: 'assessment.projected',
              actor: 'ana',
              ts: '2027-10-01T10:00:00Z',
              payload: {},
            },
          ]),
          SCOPE,
          CHAVE,
          1,
          e,
        ),
      );

      const fatos = answer.claims.filter((c) => c.kind === 'fact');
      expect(fatos).toHaveLength(2);
      expect(fatos.map((f) => f.citations[0]!.eventSeq)).toEqual([1, 4]);
    });

    it('rejeição traz o motivo gravado no payload', async () => {
      const answer = await ancorada((e) =>
        historico(
          poolDeFila([
            {
              event_seq: '2',
              action: 'output.rejected',
              actor: 'ana',
              ts: '2027-09-15T10:00:00Z',
              payload: { reason: 'duplicate_document' },
            },
          ]),
          SCOPE,
          CHAVE,
          1,
          e,
        ),
      );

      expect(textos(answer)).toContain('duplicate_document');
    });

    it('sem chave de acesso, pede a chave em vez de adivinhar o documento', async () => {
      const answer = await ancorada((e) =>
        historico(poolDeFila([]), SCOPE, undefined, 1, e),
      );

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/44/);
    });

    it('chave sem evento nenhum não recebe histórico inventado', async () => {
      const answer = await ancorada((e) => historico(poolDeFila([]), SCOPE, CHAVE, 1, e));

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/Nenhum evento no log/);
    });

    it('explica que cada número citado é reproduzível por replay', async () => {
      const answer = await ancorada((e) =>
        historico(
          poolDeFila([
            {
              event_seq: '1',
              action: 'doc.received',
              actor: 'ana',
              ts: '2027-09-15T10:00:00Z',
              payload: {},
            },
          ]),
          SCOPE,
          CHAVE,
          1,
          e,
        ),
      );

      expect(textos(answer)).toMatch(/POST \/verify/);
    });
  });
});
