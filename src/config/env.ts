/**
 * Configuração vinda do ambiente. Nada aqui tem default de produção: uma chave
 * ausente falha no start, não na primeira requisição. Ver `.env.example`.
 */
export interface Env {
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
}

export class EnvError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Variáveis de ambiente obrigatórias ausentes: ${missing.join(', ')}. ` +
        'Ver .env.example.',
    );
    this.name = 'EnvError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const missing: string[] = [];

  const required = (key: string): string => {
    const value = source[key]?.trim();
    if (!value) {
      missing.push(key);
      return '';
    }
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');

  const jwtSecret = source['SUPABASE_JWT_SECRET']?.trim();
  const jwksUrl = source['SUPABASE_JWKS_URL']?.trim();

  // Um dos dois é obrigatório: sem material de verificação, a API aceitaria
  // qualquer token, o que é pior do que não subir.
  if (!jwtSecret && !jwksUrl) {
    missing.push('SUPABASE_JWT_SECRET (ou SUPABASE_JWKS_URL)');
  }

  if (missing.length > 0) {
    throw new EnvError(missing);
  }

  const env: Env = {
    port: Number(source['API_PORT'] ?? 3000),
    host: source['API_HOST'] ?? '0.0.0.0',
    databaseUrl,
    corsOrigins: parseOrigins(source['CORS_ORIGINS']),
    supabase: {
      url: supabaseUrl,
      anonKey,
      audience: source['SUPABASE_JWT_AUDIENCE'] ?? 'authenticated',
    },
    logLevel: source['LOG_LEVEL'] ?? 'info',
  };

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
