/**
 * Configuração vinda do ambiente. Nada aqui tem default de produção: uma chave
 * ausente falha no start, não na primeira requisição. Ver `.env.example`.
 */
/**
 * Em qual ambiente esta instância roda. Não há padrão: um esquecimento aqui,
 * se virasse `dev`, deixaria produção cobrar pelo sandbox; se virasse `prod`,
 * esconderia do desenvolvedor que ele está apontando para o banco real.
 */
export type AuditEnvironment = 'dev' | 'prod';

const AUDIT_ENVIRONMENTS: readonly AuditEnvironment[] = ['dev', 'prod'];

export const ASAAS_PRODUCTION_URL = 'https://api.asaas.com/v3';
export const ASAAS_SANDBOX_URL = 'https://api-sandbox.asaas.com/v3';

export interface Env {
  environment: AuditEnvironment;
  port: number;
  host: string;
  databaseUrl: string;
  corsOrigins: string[];
  supabase: {
    url: string;
    /**
     * Segredo HS256 dos JWTs do Supabase Auth (Project Settings → API → JWT
     * Secret). Alternativa: `jwksUrl`, para projetos com chaves assimétricas.
     */
    jwtSecret?: string;
    jwksUrl?: string;
    /** Chave anon do projeto; usada só para o grant de senha em POST /auth/login. */
    anonKey: string;
    /** Público esperado no claim `aud`. */
    audience: string;
  };
  logLevel: string;
  /**
   * Chave mestra da cifragem do PFX do certificado A1. Fora do banco de
   * propósito: guardá-la junto do dado que ela protege anularia a cifragem.
   * Gere com `openssl rand -base64 48`.
   */
  certificateMasterKey: string;
  /**
   * Chave anterior, durante a janela de rotação.
   *
   * Existe só entre trocar a chave e terminar a recifragem: o cofre cifra com a
   * atual e decifra com qualquer uma das duas. Sem ela, rotacionar tornaria
   * ilegível todo PFX já guardado — e não há recuperação, porque a senha do
   * certificado não é guardada em lugar nenhum.
   */
  certificateMasterKeyPrevious?: string;
  /**
   * Ausente até a cobrança entrar no ar. Sem ela a API sobe e a cobrança roda em
   * modo "só cálculo": planos, calculadora e prévia de fatura funcionam, nada é
   * enviado ao gateway. Falhar o start por falta de credencial de pagamento
   * impediria de operar as primeiras ondas.
   */
  asaas?: { apiKey: string; baseUrl: string };
  /**
   * Token que o Asaas envia em `asaas-access-token`. Sem ele o webhook responde
   * 503 em vez de ficar aberto: um POST anônimo poderia marcar fatura como paga.
   */
  asaasWebhookToken?: string;
  /**
   * Camada 3 do assistente. Ausente, o assistente responde só o que a consulta
   * determinística cobre, e diz "não sei" para o resto — que é o comportamento
   * correto sem modelo, não uma falha.
   */
  anthropic?: { apiKey: string; model: string };
}

export class EnvError extends Error {
  constructor(missing: readonly string[], invalid: readonly string[] = []) {
    const partes: string[] = [];
    if (missing.length > 0) {
      partes.push(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(', ')}.`);
    }
    if (invalid.length > 0) {
      partes.push(`Configuração inválida: ${invalid.join('; ')}.`);
    }
    super(`${partes.join(' ')} Ver .env.example.`);
    this.name = 'EnvError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const missing: string[] = [];
  const invalid: string[] = [];

  const required = (key: string): string => {
    const value = source[key]?.trim();
    if (!value) {
      missing.push(key);
      return '';
    }
    return value;
  };

  const environmentRaw = required('AUDIT_ENV');
  const environment = AUDIT_ENVIRONMENTS.find((e) => e === environmentRaw);
  if (environmentRaw !== '' && environment === undefined) {
    invalid.push(`AUDIT_ENV deve ser 'dev' ou 'prod', veio '${environmentRaw}'`);
  }

  const databaseUrl = required('DATABASE_URL');
  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const certificateMasterKey = required('CERTIFICATE_MASTER_KEY');
  const certificateMasterKeyPrevious = source['CERTIFICATE_MASTER_KEY_PREVIOUS']?.trim();

  const jwtSecret = source['SUPABASE_JWT_SECRET']?.trim();
  const jwksUrl = source['SUPABASE_JWKS_URL']?.trim();

  // Um dos dois é obrigatório: sem material de verificação, a API aceitaria
  // qualquer token, o que é pior do que não subir.
  if (!jwtSecret && !jwksUrl) {
    missing.push('SUPABASE_JWT_SECRET (ou SUPABASE_JWKS_URL)');
  }

  const corsRaw = source['CORS_ORIGINS'];
  const webhookToken = source['ASAAS_WEBHOOK_TOKEN']?.trim();
  const asaasApiKey = source['ASAAS_API_KEY']?.trim();
  const asaasBaseUrlRaw = source['ASAAS_BASE_URL']?.trim();

  if (environment === 'prod') {
    // O padrão de CORS é o frontend local; em produção ele não serviria a
    // ninguém e a falha apareceria só no navegador do cliente.
    if (!corsRaw || corsRaw.trim().length === 0) {
      missing.push('CORS_ORIGINS');
    }
    // Com a chave de produção e a URL em branco, a cobrança ia para o sandbox:
    // nenhuma fatura real, e nenhum erro dizendo isso.
    if (asaasApiKey) {
      if (!asaasBaseUrlRaw) {
        missing.push('ASAAS_BASE_URL');
      } else if (asaasBaseUrlRaw !== ASAAS_PRODUCTION_URL) {
        invalid.push(`em prod, ASAAS_BASE_URL deve ser ${ASAAS_PRODUCTION_URL}`);
      }
      if (!webhookToken) {
        missing.push('ASAAS_WEBHOOK_TOKEN');
      }
    }
  }
  // Dev cobrando cliente de verdade é pior do que dev sem cobrança. O banco é o
  // mesmo nos dois ambientes; o que dev não pode é falar com o gateway real.
  if (environment === 'dev' && asaasBaseUrlRaw === ASAAS_PRODUCTION_URL) {
    invalid.push('em dev, ASAAS_BASE_URL não pode apontar para o Asaas de produção');
  }

  if (missing.length > 0 || invalid.length > 0 || environment === undefined) {
    throw new EnvError(missing, invalid);
  }

  const env: Env = {
    environment,
    port: Number(source['API_PORT'] ?? 3000),
    host: source['API_HOST'] ?? '0.0.0.0',
    databaseUrl,
    corsOrigins: parseOrigins(corsRaw),
    supabase: {
      url: supabaseUrl,
      anonKey,
      audience: source['SUPABASE_JWT_AUDIENCE'] ?? 'authenticated',
    },
    logLevel: source['LOG_LEVEL'] ?? 'info',
    certificateMasterKey,
    ...(certificateMasterKeyPrevious === undefined || certificateMasterKeyPrevious === ''
      ? {}
      : { certificateMasterKeyPrevious }),
  };

  if (webhookToken) {
    env.asaasWebhookToken = webhookToken;
  }

  if (asaasApiKey) {
    env.asaas = {
      apiKey: asaasApiKey,
      // Só chega aqui sem URL em dev: em prod a ausência já falhou acima.
      baseUrl: asaasBaseUrlRaw || ASAAS_SANDBOX_URL,
    };
  }

  const anthropicKey = source['ANTHROPIC_API_KEY']?.trim();
  if (anthropicKey) {
    env.anthropic = {
      apiKey: anthropicKey,
      // O ADR-026 reserva a camada 3 a Sonnet/Opus.
      model: source['ASSISTANT_MODEL']?.trim() || 'claude-opus-5',
    };
  }

  if (jwtSecret) {
    env.supabase.jwtSecret = jwtSecret;
  }
  if (jwksUrl) {
    env.supabase.jwksUrl = jwksUrl;
  }

  return env;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    // Só o frontend local. Liberar '*' por omissão seria transformar um
    // esquecimento de configuração em CORS aberto num produto que custodia
    // certificado digital de terceiros.
    return ['http://localhost:5173'];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
