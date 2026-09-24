import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeLanguageModel,
  ModelFormatError,
  ModelRefusalError,
  lerResposta,
} from '../../../src/fiscal/assistant/claude-language-model.js';

/** Cliente do SDK dublado: grava a requisição e devolve a resposta dada. */
function cliente(resposta: Record<string, unknown>): { client: Anthropic; pedidos: Record<string, unknown>[] } {
  const pedidos: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          pedidos.push(params);
          return resposta;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, pedidos };
}

const OK = {
  stop_reason: 'end_turn',
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        answerable: true,
        reason: null,
        claims: [{ kind: 'fact', text: 'A competência 2027-11 está aberta.', evidenceIds: ['E1'] }],
      }),
    },
  ],
};

const PEDIDO = { question: 'como está o cliente?', evidence: [{ id: 'E1', text: 'A competência 2027-11 está aberta.' }] };

describe('ClaudeLanguageModel', () => {
  it('usa claude-opus-5 por padrão, que é camada 3 no ADR-026', () => {
    expect(new ClaudeLanguageModel({ client: cliente(OK).client }).name).toBe('claude-opus-5');
  });

  it('pede saída estruturada, fallback do servidor e cache da instrução fixa', async () => {
    const { client, pedidos } = cliente(OK);
    await new ClaudeLanguageModel({ client }).complete(PEDIDO);

    const p = pedidos[0]!;
    expect(p).toMatchObject({
      model: 'claude-opus-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema' } },
    });
    expect((p['system'] as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  /** O que varia vai depois do prefixo em cache: evidências e pergunta, na mensagem do usuário. */
  it('evidências e pergunta vão na mensagem, não na instrução fixa', async () => {
    const { client, pedidos } = cliente(OK);
    await new ClaudeLanguageModel({ client }).complete(PEDIDO);

    const conteudo = (pedidos[0]!['messages'] as { content: string }[])[0]!.content;
    expect(conteudo).toContain('E1: A competência 2027-11 está aberta.');
    expect(conteudo).toContain('como está o cliente?');
    expect(JSON.stringify(pedidos[0]!['system'])).not.toContain('2027-11');
  });

  it('devolve a resposta lida', async () => {
    const r = await new ClaudeLanguageModel({ client: cliente(OK).client }).complete(PEDIDO);

    expect(r).toEqual({
      answerable: true,
      reason: null,
      claims: [{ kind: 'fact', text: 'A competência 2027-11 está aberta.', evidenceIds: ['E1'] }],
    });
  });

  it('respeita o modelo configurado', async () => {
    const { client, pedidos } = cliente(OK);
    await new ClaudeLanguageModel({ client, model: 'claude-sonnet-5' }).complete(PEDIDO);

    expect(pedidos[0]!['model']).toBe('claude-sonnet-5');
  });

  it('recusa da cadeia inteira vira ModelRefusalError', async () => {
    const { client } = cliente({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });

    await expect(new ClaudeLanguageModel({ client }).complete(PEDIDO)).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it('resposta cortada no limite de tokens é erro de formato, não resposta parcial', async () => {
    const { client } = cliente({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"answ' }] });

    await expect(new ClaudeLanguageModel({ client }).complete(PEDIDO)).rejects.toBeInstanceOf(ModelFormatError);
  });
});

describe('lerResposta', () => {
  it('JSON inválido é erro de formato', () => {
    expect(() => lerResposta('não é json')).toThrow(ModelFormatError);
  });

  it('afirmação fora do formato é erro', () => {
    expect(() =>
      lerResposta(JSON.stringify({ answerable: true, reason: null, claims: [{ kind: 'opinião', text: 'x', evidenceIds: [] }] })),
    ).toThrow(ModelFormatError);
  });

  it('motivo em branco vira null', () => {
    expect(lerResposta(JSON.stringify({ answerable: false, reason: '  ', claims: [] })).reason).toBeNull();
  });
});
