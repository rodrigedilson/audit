import { describe, it, expect } from 'vitest';
import {
  loadEnv,
  EnvError,
  ASAAS_PRODUCTION_URL,
  ASAAS_SANDBOX_URL,
} from '../../src/config/env.js';

/** O mínimo para `loadEnv` passar, fora do que o ambiente muda. */
const BASE = {
  DATABASE_URL: 'postgres://audit:audit@localhost:55432/audit_test',
  SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
  SUPABASE_ANON_KEY: 'chave-anon-de-teste',
  SUPABASE_JWT_SECRET: 'segredo-de-teste',
  CERTIFICATE_MASTER_KEY: 'chave-mestra-de-teste-com-mais-de-32-caracteres',
} as const;

const PROD = {
  ...BASE,
  AUDIT_ENV: 'prod',
  CORS_ORIGINS: 'https://app.exemplo.com.br',
} as const;

const erroDe = (source: NodeJS.ProcessEnv): string => {
  try {
    loadEnv(source);
  } catch (erro) {
    expect(erro).toBeInstanceOf(EnvError);
    return (erro as Error).message;
  }
  throw new Error('loadEnv deveria ter falhado');
};

describe('loadEnv — AUDIT_ENV', () => {
  it('é obrigatória: ausente, o start falha em vez de adivinhar o ambiente', () => {
    expect(erroDe({ ...BASE })).toContain('AUDIT_ENV');
  });

  it('recusa valor fora de dev e prod', () => {
    expect(erroDe({ ...BASE, AUDIT_ENV: 'production' })).toMatch(/'dev' ou 'prod'/);
  });

  it('expõe o ambiente lido', () => {
    expect(loadEnv({ ...BASE, AUDIT_ENV: 'dev' }).environment).toBe('dev');
    expect(loadEnv({ ...PROD }).environment).toBe('prod');
  });
});

describe('loadEnv — prod', () => {
  it('exige CORS_ORIGINS, cujo padrão só serve ao frontend local', () => {
    const { CORS_ORIGINS: _, ...semCors } = PROD;
    expect(erroDe(semCors)).toContain('CORS_ORIGINS');
  });

  it('com chave do Asaas, exige a URL — sem ela a cobrança ia para o sandbox', () => {
    const mensagem = erroDe({ ...PROD, ASAAS_API_KEY: 'chave', ASAAS_WEBHOOK_TOKEN: 't' });
    expect(mensagem).toContain('ASAAS_BASE_URL');
  });

  it('recusa o sandbox do Asaas', () => {
    const mensagem = erroDe({
      ...PROD,
      ASAAS_API_KEY: 'chave',
      ASAAS_BASE_URL: ASAAS_SANDBOX_URL,
      ASAAS_WEBHOOK_TOKEN: 't',
    });
    expect(mensagem).toContain(ASAAS_PRODUCTION_URL);
  });

  it('com chave do Asaas, exige o token do webhook', () => {
    const mensagem = erroDe({
      ...PROD,
      ASAAS_API_KEY: 'chave',
      ASAAS_BASE_URL: ASAAS_PRODUCTION_URL,
    });
    expect(mensagem).toContain('ASAAS_WEBHOOK_TOKEN');
  });

  it('sem chave do Asaas, sobe em modo só cálculo', () => {
    expect(loadEnv({ ...PROD }).asaas).toBeUndefined();
  });

  it('aceita a configuração completa de cobrança', () => {
    const env = loadEnv({
      ...PROD,
      ASAAS_API_KEY: 'chave',
      ASAAS_BASE_URL: ASAAS_PRODUCTION_URL,
      ASAAS_WEBHOOK_TOKEN: 't',
    });
    expect(env.asaas?.baseUrl).toBe(ASAAS_PRODUCTION_URL);
  });

  it('reporta todas as faltas de uma vez', () => {
    const { CORS_ORIGINS: _, ...semCors } = PROD;
    const mensagem = erroDe({ ...semCors, ASAAS_API_KEY: 'chave' });
    expect(mensagem).toContain('CORS_ORIGINS');
    expect(mensagem).toContain('ASAAS_BASE_URL');
    expect(mensagem).toContain('ASAAS_WEBHOOK_TOKEN');
  });
});

describe('loadEnv — dev', () => {
  const DEV = { ...BASE, AUDIT_ENV: 'dev' } as const;

  it('sem ASAAS_BASE_URL, usa o sandbox', () => {
    expect(loadEnv({ ...DEV, ASAAS_API_KEY: 'chave' }).asaas?.baseUrl).toBe(ASAAS_SANDBOX_URL);
  });

  it('recusa o Asaas de produção', () => {
    const mensagem = erroDe({ ...DEV, ASAAS_API_KEY: 'chave', ASAAS_BASE_URL: ASAAS_PRODUCTION_URL });
    expect(mensagem).toMatch(/Asaas de produção/);
  });

  it('não exige CORS_ORIGINS: o padrão é o frontend local', () => {
    expect(loadEnv({ ...DEV }).corsOrigins).toEqual(['http://localhost:5173']);
  });
});

describe('loadEnv — assistente', () => {
  const DEV = { ...BASE, AUDIT_ENV: 'dev' } as const;

  it('sem ANTHROPIC_API_KEY, não há camada 3', () => {
    expect(loadEnv({ ...DEV }).anthropic).toBeUndefined();
  });

  it('com a chave, a camada 3 usa claude-opus-5 por padrão', () => {
    expect(loadEnv({ ...DEV, ANTHROPIC_API_KEY: 'sk-teste' }).anthropic).toEqual({
      apiKey: 'sk-teste',
      model: 'claude-opus-5',
    });
  });

  it('ASSISTANT_MODEL troca o modelo', () => {
    expect(loadEnv({ ...DEV, ANTHROPIC_API_KEY: 'sk-teste', ASSISTANT_MODEL: 'claude-sonnet-5' }).anthropic?.model).toBe(
      'claude-sonnet-5',
    );
  });
});
