import Anthropic from '@anthropic-ai/sdk';
import type {
  LanguageModelPort,
  ModelAnswer,
  ModelClaim,
  ModelRequest,
} from './language-model.port.js';

/** Modelo padrão da camada 3. O ADR-026 reserva a camada 3 a Sonnet/Opus. */
export const MODELO_PADRAO = 'claude-opus-5';

/** O modelo recusou (classificador de segurança) mesmo depois da fallback. */
export class ModelRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRefusalError';
  }
}

/** A resposta do modelo não veio no formato combinado. */
export class ModelFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelFormatError';
  }
}

/**
 * Instrução fixa. É a mesma em toda requisição, e por isso fica em cache: o que
 * varia (evidências e pergunta) vai na mensagem do usuário, depois dela.
 */
const SISTEMA = `Você é o assistente fiscal de um escritório de contabilidade brasileiro, respondendo sobre UM CNPJ.

Você recebe a pergunta do contador e uma lista de evidências numeradas (E1, E2…). Cada evidência é um fato que o sistema já apurou dos dados deste CNPJ, com lastro no log de eventos.

Regras, sem exceção:
- Responda usando só as evidências. Você não tem acesso a mais nada deste CNPJ.
- Toda afirmação sobre os dados do CNPJ é um "fact" e cita, em "evidenceIds", as evidências que a sustentam.
- Valores em R$ e competências (AAAA-MM) só aparecem num "fact", escritos exatamente como na evidência citada. Não some, não arredonde e não calcule valores novos.
- "explanation" é só texto normativo ou de procedimento, sem valor e sem competência.
- Se as evidências não respondem à pergunta, devolva answerable=false e diga em "reason" o que faltaria. Resposta plausível sem lastro é o pior resultado possível aqui.
- Escreva em português do Brasil, frases curtas e diretas, para um contador.`;

/** Formato de saída: o modelo só pode citar por id de evidência. */
const FORMATO = {
  type: 'object',
  additionalProperties: false,
  required: ['answerable', 'reason', 'claims'],
  properties: {
    answerable: { type: 'boolean' },
    reason: { type: ['string', 'null'] },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'evidenceIds'],
        properties: {
          kind: { type: 'string', enum: ['fact', 'explanation'] },
          text: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export interface ClaudeLanguageModelOptions {
  /** Cliente do SDK. Injetável para os testes, que não chamam a API. */
  client?: Anthropic;
  apiKey?: string;
  model?: string;
}

/**
 * Camada 3 do assistente sobre a API da Anthropic.
 *
 * Três escolhas:
 *
 * - **Saída estruturada** (`output_config.format`). A resposta é JSON no
 *   formato de `ModelAnswer`, e o modelo só cita evidência por id. Texto livre
 *   exigiria extrair citação de prosa, que é onde a citação inventada se
 *   esconde.
 * - **Fallback do servidor** (`fallbacks: "default"`). Se o classificador de
 *   segurança recusar, a própria API reexecuta num modelo substituto. Pergunta
 *   fiscal raramente cai nisso, mas "não sei" por recusa seria confuso para o
 *   contador. Se a cadeia inteira recusar, sai `ModelRefusalError`.
 * - **Cache do prefixo.** A instrução fixa é a mesma em toda pergunta.
 */
export class ClaudeLanguageModel implements LanguageModelPort {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(options: ClaudeLanguageModelOptions = {}) {
    this.name = options.model ?? MODELO_PADRAO;
    this.client =
      options.client ?? new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
  }

  async complete(request: ModelRequest): Promise<ModelAnswer> {
    const evidencias = request.evidence.map((e) => `${e.id}: ${e.text}`).join('\n');

    const response = await this.client.beta.messages.create({
      model: this.name,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: FORMATO } },
      messages: [
        {
          role: 'user',
          content: `Evidências:\n${evidencias || '(nenhuma)'}\n\nPergunta do contador:\n${request.question}`,
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      throw new ModelRefusalError(
        `O modelo recusou a pergunta${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ModelFormatError('A resposta do modelo foi cortada no limite de tokens.');
    }

    const texto = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return lerResposta(texto);
  }
}

/**
 * Lê e confere o JSON do modelo. A saída estruturada garante o formato, e a
 * conferência aqui é a fronteira: o que sai daqui entra no serviço como tipo.
 */
export function lerResposta(texto: string): ModelAnswer {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new ModelFormatError('A resposta do modelo não é JSON.');
  }

  const r = bruto as Partial<ModelAnswer>;
  if (typeof r.answerable !== 'boolean' || !Array.isArray(r.claims)) {
    throw new ModelFormatError('A resposta do modelo não traz answerable e claims.');
  }

  const claims: ModelClaim[] = r.claims.map((c: Partial<ModelClaim>) => {
    if (
      (c.kind !== 'fact' && c.kind !== 'explanation') ||
      typeof c.text !== 'string' ||
      !Array.isArray(c.evidenceIds) ||
      !c.evidenceIds.every((id) => typeof id === 'string')
    ) {
      throw new ModelFormatError('Afirmação do modelo fora do formato combinado.');
    }
    return { kind: c.kind, text: c.text, evidenceIds: c.evidenceIds };
  });

  return {
    answerable: r.answerable,
    reason: typeof r.reason === 'string' && r.reason.trim() !== '' ? r.reason : null,
    claims,
  };
}
