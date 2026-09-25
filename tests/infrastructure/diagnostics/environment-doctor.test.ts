import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  diagnosticar,
  classificarFalhaDeConexao,
  checarTrilhas,
  checarPrazosNormativos,
  checarCotaDoAssistente,
  checarCnpjAlfanumerico,
  checarExposicaoAoAnon,
  checarTrilhaDeSeguranca,
  checarCobranca,
  checarEmailDoDiagnostico,
  checarIndicesFinanceiros,
  checarCertificadosParaColeta,
} from '../../../src/infrastructure/diagnostics/environment-doctor.js';
import { applyMigrations } from '../../helpers/db.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** Variáveis mínimas para o doctor passar da primeira checagem. */
const ENV_BASE = {
  AUDIT_ENV: 'dev',
  SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
  SUPABASE_ANON_KEY: 'chave-anon-de-teste',
  SUPABASE_JWT_SECRET: 'segredo-de-teste',
  CERTIFICATE_MASTER_KEY: 'chave-mestra-de-teste-com-mais-de-32-caracteres',
  LOG_LEVEL: 'silent',
} as const;

const checagem = (resultado: Awaited<ReturnType<typeof diagnosticar>>, nome: string) =>
  resultado.checagens.find((c) => c.nome === nome);

describe('diagnosticar — sem precisar de banco', () => {
  it('reporta todas as variáveis faltando de uma vez, em vez de uma por execução', async () => {
    const resultado = await diagnosticar({} as NodeJS.ProcessEnv);

    expect(resultado.ok).toBe(false);
    const env = checagem(resultado, 'variáveis de ambiente');
    expect(env?.estado).toBe('falha');
    expect(env?.detalhe).toContain('DATABASE_URL');
    expect(env?.detalhe).toContain('SUPABASE_URL');
    expect(env?.detalhe).toContain('CERTIFICATE_MASTER_KEY');
    expect(env?.acao).toMatch(/docs\/setup\/SUPABASE\.md/);
  });

  it('para na primeira checagem quando o ambiente está vazio, sem tentar conectar', async () => {
    const resultado = await diagnosticar({} as NodeJS.ProcessEnv);

    // Sem DATABASE_URL não há o que conectar; seguir adiante só produziria
    // erros derivados que escondem a causa.
    expect(resultado.checagens).toHaveLength(1);
  });

  // Timeout folgado: resolver um host inexistente pode levar segundos, e é o
  // próprio caminho que este teste exercita.
  it('não segue para as checagens de schema quando a conexão falha', async () => {
    const resultado = await diagnosticar({
      ...ENV_BASE,
      DATABASE_URL: 'postgresql://u:p@host-que-nao-existe.invalid:5432/postgres',
    } as NodeJS.ProcessEnv);

    expect(checagem(resultado, 'conexão com o banco')?.estado).toBe('falha');
    expect(checagem(resultado, 'schema')).toBeUndefined();
  }, 20_000);
});

/**
 * As mensagens abaixo são as reais, colhidas de cada falha ao configurar este
 * projeto. Testar a classificação em vez de reproduzir a condição de rede é o
 * que mantém o teste estável: um literal IPv6 sem rota dá ENOTFOUND no
 * resolvedor, não o ENETUNREACH que o host real produz.
 */
describe('classificarFalhaDeConexao', () => {
  it('ENETUNREACH aponta o IPv6 do host direto do Supabase', () => {
    const c = classificarFalhaDeConexao(
      'connect ENETUNREACH 2600:1f18:5905:6801:a528:113c:270f:8c3a:5432 - Local (:::0)',
    );

    expect(c.estado).toBe('falha');
    expect(c.acao).toMatch(/IPv6/);
    // Aponta a ferramenta de descoberta: o hostname do pooler não é adivinhável.
    expect(c.acao).toMatch(/npm run pooler/);
  });

  it('ENOTFOUND aponta erro de nome, não de rede', () => {
    const c = classificarFalhaDeConexao('getaddrinfo ENOTFOUND db.projeto-errado.supabase.co');

    expect(c.acao).toMatch(/não resolve no DNS/);
    expect(c.acao).not.toMatch(/IPv6/);
  });

  it('senha errada aponta o URL-encode, causa comum e silenciosa', () => {
    const c = classificarFalhaDeConexao('password authentication failed for user "postgres"');

    expect(c.acao).toMatch(/URL-encode/);
    expect(c.acao).toMatch(/Reset database password/);
  });

  it('timeout aponta firewall e porta', () => {
    const c = classificarFalhaDeConexao('connect ETIMEDOUT 1.2.3.4:6543');

    expect(c.acao).toMatch(/5432/);
    expect(c.acao).toMatch(/6543/);
  });

  it('banco inexistente aponta o nome no fim da URL', () => {
    const c = classificarFalhaDeConexao('database "audit" does not exist');

    expect(c.acao).toMatch(/postgres/);
  });

  it('erro desconhecido ainda devolve uma ação, não silêncio', () => {
    const c = classificarFalhaDeConexao('algo totalmente inesperado');

    expect(c.acao).toBeDefined();
    expect(c.detalhe).toBe('algo totalmente inesperado');
  });
});

describe.skipIf(!DATABASE_URL)('diagnosticar — contra banco real', () => {
  let admin: pg.Pool;
  let baseVazia: string;
  let urlVazia: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    // Ver `ignorarErroDeClienteOcioso`: sem listener, um cliente ocioso que o
    // banco encerra vira exceção não capturada e derruba a suíte inteira, com
    // todos os testes passando.
    admin.on('error', () => undefined);

    // Nome único: os arquivos de teste rodam em paralelo, e um nome fixo faria
    // um arquivo derrubar a base do outro.
    baseVazia = `doctor_${Math.random().toString(36).slice(2, 10)}`;
    await admin.query(`create database ${baseVazia}`);
    urlVazia = DATABASE_URL!.replace(/\/[^/]+$/, `/${baseVazia}`);
  });

  afterAll(async () => {
    /**
     * Encerra as conexões da base temporária **antes** do drop.
     *
     * `with (force)` derruba o que sobrou, e é aí que o Postgres emite 57P01
     * para clientes que ainda existam. Fechar antes remove a corrida em vez de
     * só tolerá-la; os listeners de `error` cobrem o resto, porque o
     * encerramento do socket ainda pode chegar depois do `end()` resolver.
     */
    await admin
      .query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [baseVazia],
      )
      .catch(() => undefined);

    await admin.query(`drop database if exists ${baseVazia} with (force)`).catch(() => undefined);
    await admin.end();
  });

  it('conecta e identifica o Postgres', async () => {
    const resultado = await diagnosticar({
      ...ENV_BASE,
      DATABASE_URL,
    } as NodeJS.ProcessEnv);

    const conexao = checagem(resultado, 'conexão com o banco');
    expect(conexao?.estado).toBe('ok');
    expect(conexao?.detalhe).toMatch(/PostgreSQL/);
  });

  describe('banco sem nenhuma migration', () => {
    it('lista as tabelas faltando e os arquivos a rodar', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      const schema = checagem(resultado, 'schema');
      expect(schema?.estado).toBe('falha');
      expect(schema?.detalhe).toMatch(/^faltam \d+ de \d+:/);
      // A ação nomeia os arquivos a rodar, na ordem.
      expect(schema?.acao).toContain('01-multi-tenancy.sql');
      expect(schema?.acao).toContain('04-ingestao.sql');
      expect(schema?.acao).toContain('05-catalogo-de-itens.sql');
    });

    /**
     * Antes desta guarda, o doctor estourava com `relation "plans" does not
     * exist` e escondia o diagnóstico real, que é o schema faltando.
     */
    it('não estoura nas checagens que dependem das tabelas', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      const dependentes = checagem(resultado, 'carga inicial e escritório');
      expect(dependentes?.estado).toBe('aviso');
      expect(dependentes?.detalhe).toMatch(/depende do schema/);
      expect(resultado.ok).toBe(false);
    });

    it('acusa a ausência do trigger append-only', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      const trigger = checagem(resultado, 'event log append-only');
      expect(trigger?.estado).toBe('falha');
      expect(trigger?.detalhe).toMatch(/UPDATE e DELETE em events não estão bloqueados/);
    });
  });

  describe('banco com schema aplicado', () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: urlVazia, max: 1 });
      pool.on('error', () => undefined);
      await applyMigrations(pool);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('reconhece schema, funções e trigger', async () => {
      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      expect(checagem(resultado, 'schema')?.estado).toBe('ok');
      expect(checagem(resultado, 'funções')?.estado).toBe('ok');
      expect(checagem(resultado, 'event log append-only')?.estado).toBe('ok');
    });

    it('reconhece a carga inicial de cobrança semeada pela migration', async () => {
      const carga = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'carga inicial de cobrança',
      );

      expect(carga?.estado).toBe('ok');
      expect(carga?.detalhe).toContain('5 planos');
    });

    /**
     * É o caso que aconteceu de verdade: as tabelas chegaram e os INSERT de
     * carga não. A calculadora de preço pública passa a devolver lista vazia sem
     * erro, e a fatura só falha no fechamento do mês.
     */
    it('acusa carga inicial ausente com schema presente', async () => {
      await pool.query('delete from plans');
      await pool.query('delete from billing_settings');

      try {
        const carga = checagem(
          await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
          'carga inicial de cobrança',
        );

        expect(carga?.estado).toBe('falha');
        expect(carga?.detalhe).toContain('0 planos (esperado 5)');
        expect(carga?.acao).toContain('03-cobranca.sql');
      } finally {
        await applyMigrations(pool);
      }
    });

    it('reconhece o catálogo de trilhas semeado pela migration', async () => {
      const trilhas = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'trilhas de auditoria',
      );

      expect(trilhas?.estado).toBe('ok');
      expect(trilhas?.detalhe).toMatch(/1[2-9]|[2-9]\d/);
    });

    it('acusa a falta de escritório, que faria a API responder 403 em tudo', async () => {
      const escritorio = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'escritório e usuário',
      );

      expect(escritorio?.estado).toBe('falha');
      expect(escritorio?.acao).toContain('bootstrap-escritorio.sql');
      expect(escritorio?.acao).toMatch(/Auto Confirm User/);
    });

    /**
     * Tabela oficial vazia é AVISO, não falha: a API sobe e funciona, e a saúde
     * do cadastro reporta "não verificado" em vez de "ok". Um aviso não pode
     * reprovar o ambiente, senão ninguém conseguiria começar a usar o produto
     * antes de carregar a IT RT 2025.002.
     */
    /**
     * Regressão de um caso real: os 5 planos estavam na tabela e a API REST
     * devolvia `[]`, porque RLS ligada sem policy filtra tudo e responde 200,
     * não 403. O sintoma não aponta a causa para quem não conhece a diferença.
     */
    it('acusa plans com RLS ligada e sem policy, que devolve lista vazia sem erro', async () => {
      await pool.query('alter table plans enable row level security');

      try {
        const visibilidade = checagem(
          await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
          'visibilidade das tabelas públicas',
        );

        expect(visibilidade?.estado).toBe('falha');
        expect(visibilidade?.detalhe).toContain('plans');
        expect(visibilidade?.detalhe).toMatch(/lista vazia, não erro/);
        expect(visibilidade?.acao).toContain('reparo-planos.sql');
      } finally {
        await pool.query('alter table plans disable row level security');
      }
    });

    it('aprova a visibilidade quando o RLS das públicas está desligado', async () => {
      const visibilidade = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'visibilidade das tabelas públicas',
      );

      expect(visibilidade?.estado).toBe('ok');
      expect(visibilidade?.detalhe).toContain('plans=rls_off');
    });

    it('acusa as tabelas oficiais de códigos vazias como aviso', async () => {
      const oficiais = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'tabelas oficiais de códigos',
      );

      expect(oficiais?.estado).toBe('aviso');
      expect(oficiais?.acao).toMatch(/aprovaria qualquer/);
      // A ação nomeia o que falta, por tipo. "Carregue a IT RT 2025.002" não
      // dizia qual tipo ainda não confere nada, e com CFOP carregado e o resto
      // vazio essa era a única informação que importava.
      expect(oficiais?.acao).toMatch(/Falta: .*cfop/);
      expect(oficiais?.acao).toMatch(/pares cClassTrib/);
      expect(oficiais?.detalhe).toMatch(/0 de 7 tipos carregados/);
    });

    /**
     * Cofre vazio é o melhor momento para rotacionar a chave mestra, e o doutor
     * diz isso: depois de haver certificado, a rotação passa a exigir recifragem
     * do acervo.
     */
    it('reporta o cofre de certificados vazio como ok, e diz o que isso permite', async () => {
      const cofre = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'cofre de certificados A1',
      );

      expect(cofre?.estado).toBe('ok');
      expect(cofre?.detalhe).toMatch(/sem custo/);
    });

    /**
     * A verificação pós-rotação que não depende do secret manager: um comando
     * diz se sobrou certificado na chave antiga. Sem ela, descobrir exigiria
     * tentar usar o certificado — no momento em que a coleta de DF-e falha.
     */
    it('acusa certificado fora da chave atual como aviso, sem reprovar o ambiente', async () => {
      // `certificates` tem FK para `clients`, que tem FK para `tenants`.
      await pool.query(
        `insert into tenants (id, name)
         values ('44444444-4444-4444-4444-444444444444', 'Escritório do cofre')
         on conflict do nothing`,
      );
      await pool.query(
        `insert into clients (tenant_id, cnpj, legal_name, regime)
         values ('44444444-4444-4444-4444-444444444444'::uuid, '11122233300011',
                 'Cliente do cofre', 'simples_hibrido'::regime)
         on conflict do nothing`,
      );
      await pool.query(
        `insert into certificates (
           tenant_id, cnpj, encrypted_pfx, fingerprint, key_id,
           subject, issuer, serial, valid_from, valid_to, stored_by
         ) values (
           '44444444-4444-4444-4444-444444444444'::uuid, '11122233300011',
           'cifrado-de-teste', repeat('a', 64), 'chavedeoutrotempo',
           'CN=TESTE', 'AC Teste', 'A1B2', now(), now() + interval '90 days',
           '55555555-5555-5555-5555-555555555555'::uuid
         ) on conflict do nothing`,
      );

      try {
        const resultado = await diagnosticar({
          ...ENV_BASE,
          DATABASE_URL: urlVazia,
        } as NodeJS.ProcessEnv);
        const cofre = checagem(resultado, 'cofre de certificados A1');

        expect(cofre?.estado).toBe('aviso');
        expect(cofre?.detalhe).toMatch(/1 fora da chave atual/);
        expect(cofre?.acao).toMatch(/recifrar-certificados/);
        // Aviso, e não falha: a API sobe e o certificado antigo continua
        // abrindo enquanto a chave anterior estiver no ambiente. A asserção é
        // sobre esta checagem, e não sobre o ambiente inteiro — este banco de
        // teste tem outras falhas legítimas, como a ausência de escritório.
        expect(cofre?.estado).not.toBe('falha');
      } finally {
        await pool.query(`delete from certificates where cnpj = '11122233300011'`);
      }
    });

    it('aprova o ambiente quando só restam avisos', async () => {
      const tenant = '33333333-3333-3333-3333-333333333333';
      await pool.query(
        `insert into tenants (id, name) values ($1, 'Escritório') on conflict do nothing`,
        [tenant],
      );
      await pool.query(
        `insert into memberships (tenant_id, user_id, role)
         values ($1::uuid, '44444444-4444-4444-4444-444444444444', 'owner')
         on conflict do nothing`,
        [tenant],
      );

      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      expect(resultado.ok).toBe(true);
      expect(resultado.checagens.some((c) => c.estado === 'falha')).toBe(false);
      // O aviso continua visível: aprovar não é o mesmo que silenciar.
      expect(resultado.checagens.some((c) => c.estado === 'aviso')).toBe(true);
    });

    /**
     * Regra de creditamento vazia também é aviso: a apuração roda e entrega
     * débito e crédito potencial, e só o valor devido fica indeterminável.
     */
    it('acusa a falta de regra de creditamento como aviso', async () => {
      const regras = checagem(
        await diagnosticar({ ...ENV_BASE, DATABASE_URL: urlVazia } as NodeJS.ProcessEnv),
        'regras de creditamento',
      );

      expect(regras?.estado).toBe('aviso');
      expect(regras?.acao).toMatch(/pior do que\n?\s*um ausente|pior do que um ausente/);
      expect(regras?.acao).toContain('tax_rules');
    });

    it('dá tudo ok com as tabelas oficiais e as regras carregadas', async () => {
      // Os sete tipos: o doutor passou a exigir que nenhum esteja vazio, porque
      // um tipo carregado não autoriza dizer que a conferência aconteceu.
      await pool.query(
        `insert into fiscal_codes (kind, code) values
           ('ncm','73181500'),('nbs','123456789'),('cfop','5102'),
           ('cst_icms','00'),('cst_pis_cofins','01'),('cst_ibs_cbs','000'),
           ('cclasstrib','000001')
         on conflict do nothing`,
      );
      await pool.query(
        `insert into cclasstrib_cst (cclasstrib, cst_ibs_cbs) values ('000001','000')
         on conflict do nothing`,
      );
      await pool.query(
        `insert into tax_rules (kind, tax, value, valid_from, source)
         values ('credit_share', 'icms', 1.0, '2026-01-01', 'regra de teste do doctor')
         on conflict do nothing`,
      );
      await pool.query(
        `insert into deadline_rules (
           rule_id, name, description, nature, months_after, day_of_month,
           severity, legal_basis
         ) values ('prazo-de-teste-do-doctor', 'Prazo de teste',
                   'Semeado pelo teste do doctor', 'normativo', 1, 20,
                   'high', 'Norma fictícia, só para o teste do diagnóstico')
         on conflict do nothing`,
      );

      // Séries de índice em dia e conferidas: o último mês fechado, em todas.
      const agora = new Date(Date.now() - 3 * 3600_000);
      const passado = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
      const competencia = `${passado.getUTCFullYear()}-${String(passado.getUTCMonth() + 1).padStart(2, '0')}`;
      await pool.query(
        `insert into financial_index_points (index_id, period, variation, source_ref)
         select index_id, $1, 0.005, 'teste do doctor' from financial_indices
         on conflict do nothing`,
        [competencia],
      );
      await pool.query(`update financial_indices set verified = true, source_ref = 'teste do doctor', verified_at = now()`);

      const resultado = await diagnosticar({
        ...ENV_BASE,
        DATABASE_URL: urlVazia,
      } as NodeJS.ProcessEnv);

      expect(resultado.ok).toBe(true);
      expect(resultado.checagens.every((c) => c.estado === 'ok')).toBe(true);
      expect(resultado.checagens.every((c) => c.acao === undefined)).toBe(true);
    });
  });
});

/**
 * Catálogo de trilhas vazio, testado sem banco.
 *
 * Desligar as trilhas no Postgres seria mais realista, mas `audit_trails` é
 * dado normativo global: o arquivo de teste da API de reporting lê a mesma
 * tabela, e os arquivos rodam em paralelo. Um teste que apaga catálogo
 * compartilhado quebra o vizinho de forma intermitente.
 */
describe('checarTrilhas — catálogo vazio', () => {
  const poolFalso = (total: number): pg.Pool =>
    ({
      query: async () => ({ rows: [{ total: String(total) }] }),
    }) as unknown as pg.Pool;

  it('aprova com o catálogo completo', async () => {
    const r = await checarTrilhas(poolFalso(12));

    expect(r.estado).toBe('ok');
    expect(r.detalhe).toContain('12 trilhas ativas');
  });

  /**
   * Catálogo vazio não quebra nada em runtime: o relatório volta com zero
   * trilhas e o Book sai com a seção em branco. O escritório lê isso como
   * "nada de errado com o cliente" — falso negativo silencioso é o pior erro
   * que este produto pode cometer.
   */
  it('reprova catálogo vazio, que faria o Book parecer aprovado', async () => {
    const r = await checarTrilhas(poolFalso(0));

    expect(r.estado).toBe('falha');
    expect(r.detalhe).toContain('0 trilhas ativas');
    expect(r.acao).toContain('07-reporting.sql');
  });

  it('reprova catálogo parcial, não só o vazio', async () => {
    expect((await checarTrilhas(poolFalso(11))).estado).toBe('falha');
  });
});

/**
 * Prazos normativos, testado sem banco: `deadline_rules` é dado normativo
 * global, e o arquivo de teste da contra-apuração lê a mesma tabela em
 * paralelo. Mesma razão do teste de trilhas acima.
 */
describe('checarPrazosNormativos', () => {
  const poolFalso = (total: number): pg.Pool =>
    ({
      query: async () => ({ rows: [{ total: String(total) }] }),
    }) as unknown as pg.Pool;

  it('aprova quando há prazo carregado', async () => {
    const r = await checarPrazosNormativos(poolFalso(3));

    expect(r.estado).toBe('ok');
    expect(r.detalhe).toContain('3 regra(s)');
  });

  /**
   * Aviso e não falha: o calendário funciona sem prazo de norma. Mas a lista
   * vazia precisa ser lida como "nada carregado", e não como "nada a vencer".
   */
  it('avisa sem falhar quando nenhum prazo está carregado', async () => {
    const r = await checarPrazosNormativos(poolFalso(0));

    expect(r.estado).toBe('aviso');
    expect(r.acao).toContain('normative_rules_loaded');
    expect(r.acao).toContain('base legal');
  });
});

/**
 * Cota do assistente, testado sem banco: `plans` é tabela global e os arquivos
 * de teste de cobrança e do assistente leem e escrevem nela em paralelo.
 */
describe('checarCotaDoAssistente', () => {
  const poolFalso = (comCota: number, total: number): pg.Pool =>
    ({
      query: async () => ({ rows: [{ com_cota: String(comCota), total: String(total) }] }),
    }) as unknown as pg.Pool;

  it('aprova quando algum plano inclui o assistente', async () => {
    const r = await checarCotaDoAssistente(poolFalso(3, 5));

    expect(r.estado).toBe('ok');
    expect(r.detalhe).toContain('3 de 5');
  });

  /**
   * Falha, e não aviso: com cota zero em toda linha o assistente responde 403
   * para todos os clientes, sem erro em log nenhum — um recurso contratado que
   * simplesmente não aparece.
   */
  it('reprova quando nenhum plano tem cota, que faria o assistente sumir calado', async () => {
    const r = await checarCotaDoAssistente(poolFalso(0, 5));

    expect(r.estado).toBe('falha');
    expect(r.acao).toContain('403');
    expect(r.acao).toContain('09-assistente-fiscal.sql');
  });
});

/** Cobrança, testada sem banco: `subscriptions` é escrita pelos testes de API em paralelo. */
describe('checarCobranca', () => {
  const poolFalso = (colunas: number, ativadas = 0): pg.Pool =>
    ({
      query: async () => ({ rows: [{ colunas: String(colunas), ativadas: String(ativadas) }] }),
    }) as unknown as pg.Pool;

  const env = (environment: 'dev' | 'prod', comChave: boolean) =>
    ({
      environment,
      ...(comChave ? { asaas: { apiKey: 'chave', baseUrl: 'https://api.asaas.com/v3' } } : {}),
    }) as unknown as Parameters<typeof checarCobranca>[1];

  it('sem o schema da ativação, falha apontando a migration', async () => {
    const r = await checarCobranca(poolFalso(2), env('prod', true));

    expect(r.estado).toBe('falha');
    expect(r.acao).toContain('17-ativacao-da-cobranca.sql');
  });

  /** É o registro do que falta: aparece a cada doctor até as chaves chegarem. */
  it('prod sem chave: aviso com a lista do que configurar', async () => {
    const r = await checarCobranca(poolFalso(4), env('prod', false));

    expect(r.estado).toBe('aviso');
    expect(r.acao).toContain('ASAAS_WEBHOOK_TOKEN');
    expect(r.acao).toContain('/v1/webhooks/asaas');
  });

  it('prod com chave: ok, com quantos escritórios já ativaram', async () => {
    const r = await checarCobranca(poolFalso(4, 3), env('prod', true));

    expect(r.estado).toBe('ok');
    expect(r.detalhe).toContain('3 escritório(s)');
  });

  it('dev sem chave é o estado certo', async () => {
    expect((await checarCobranca(poolFalso(4), env('dev', false))).estado).toBe('ok');
  });

  it('dev com chave é aviso: o sandbox gravaria no banco de produção', async () => {
    const r = await checarCobranca(poolFalso(4), env('dev', true));

    expect(r.estado).toBe('aviso');
    expect(r.acao).toContain('produção');
  });
});

/**
 * A falha que esta checagem existe para evitar é muda: sem a migration, a `check`
 * do banco recusa o CNPJ alfanumérico e a API devolve 500 — o escritório vê
 * "erro no sistema" ao cadastrar a empresa nova que acabou de captar.
 */
describe('checarCnpjAlfanumerico', () => {
  const poolFalso = (tabelas: string[]): pg.Pool =>
    ({
      query: async () => ({ rows: tabelas.map((tabela) => ({ tabela })) }),
    }) as unknown as pg.Pool;

  it('aprova quando nenhuma restrição limita o CNPJ a dígitos', async () => {
    const r = await checarCnpjAlfanumerico(poolFalso([]));

    expect(r.estado).toBe('ok');
  });

  /** Falha, e não aviso: com a restrição antiga o cadastro simplesmente quebra. */
  it('falha nomeando as tabelas e o arquivo a rodar', async () => {
    const r = await checarCnpjAlfanumerico(poolFalso(['clients', 'events']));

    expect(r.estado).toBe('falha');
    expect(r.detalhe).toContain('clients, events');
    expect(r.detalhe).toContain('500');
    expect(r.acao).toContain('20-cnpj_alfanumerico.sql');
  });
});

/**
 * O doctor manda rodar arquivos pelo nome, e o número de cada passo muda quando
 * entra migration com timestamp anterior (branches em paralelo). Já apontou
 * o passo 19 para o CNPJ alfanumérico quando o arquivo era o 20, e o bootstrap como 05
 * quando era o 26: a ação mandava rodar um arquivo que não existe.
 */
describe('nomes de arquivo que o doctor cita', () => {
  it('todo passo citado existe em scripts/sql/migracoes', () => {
    const fonte = readFileSync(join(process.cwd(), 'src/infrastructure/diagnostics/environment-doctor.ts'), 'utf8');
    const existentes = new Set(readdirSync(join(process.cwd(), 'scripts/sql/migracoes')));
    const citados = [...new Set(fonte.match(/\b\d{2}-[a-z0-9_-]+\.sql/g) ?? [])];

    expect(citados.length).toBeGreaterThan(10);
    expect(citados.filter((c) => !existentes.has(c))).toEqual([]);
  });
});

describe('checarCertificadosParaColeta', () => {
  const pool = (existe: boolean, antigos: number, total: number): pg.Pool =>
    ({
      query: async (sql: string) =>
        sql.includes('information_schema')
          ? { rows: [{ existe }] }
          : { rows: [{ antigos: String(antigos), total: String(total) }] },
    }) as unknown as pg.Pool;

  it('todos utilizáveis: ok', async () => {
    expect((await checarCertificadosParaColeta(pool(true, 0, 3))).estado).toBe('ok');
  });

  /** Sem esta linha, o escritório só descobre que precisa reenviar quando pede a coleta. */
  it('certificado guardado antes da coleta: aviso pedindo reenvio', async () => {
    const r = await checarCertificadosParaColeta(pool(true, 2, 5));

    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toContain('2 de 5');
    expect(r.acao).toContain('reenvia');
  });

  it('sem a migration da coleta: aviso apontando o arquivo', async () => {
    const r = await checarCertificadosParaColeta(pool(false, 0, 0));
    expect(r.acao).toContain('19-coleta-dfe.sql');
  });
});

describe('checarEmailDoDiagnostico', () => {
  const pool = (colunas: number, falhas = 0, enviados = 0): pg.Pool =>
    ({
      query: async (sql: string) =>
        sql.includes('information_schema')
          ? { rows: [{ n: String(colunas) }] }
          : { rows: [{ falhas: String(falhas), enviados: String(enviados) }] },
    }) as unknown as pg.Pool;
  const env = (extra: Record<string, unknown> = {}) => ({ environment: 'prod', ...extra }) as unknown as Parameters<typeof checarEmailDoDiagnostico>[1];
  const COMPLETO = {
    mail: { smtpUrl: 'smtps://x', from: 'a@b.com', publicApiUrl: 'https://api' },
    reportEncryptionKey: 'k'.repeat(40),
    ipHashSecret: 's'.repeat(40),
  };

  it('sem a migration, falha apontando o passo', async () => {
    const r = await checarEmailDoDiagnostico(pool(2), env(COMPLETO));
    expect(r.estado).toBe('falha');
    expect(r.acao).toMatch(/relatorio-do-diagnostico\.sql/);
  });

  it('sem SMTP ou sem a chave do relatório, avisa que o e-mail não sai', async () => {
    const r = await checarEmailDoDiagnostico(pool(5), env({ reportEncryptionKey: 'k'.repeat(40) }));
    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toMatch(/MAIL_SMTP_URL/);
  });

  it('em dev, sem envio é o normal: ok', async () => {
    expect((await checarEmailDoDiagnostico(pool(5), env({ environment: 'dev' }))).estado).toBe('ok');
  });

  it('envio falhando nos últimos 7 dias: aviso', async () => {
    expect((await checarEmailDoDiagnostico(pool(5, 3), env(COMPLETO))).detalhe).toMatch(/3 envio/);
  });

  it('configurado e sem falhas: ok', async () => {
    const r = await checarEmailDoDiagnostico(pool(5, 0, 7), env(COMPLETO));
    expect(r.estado).toBe('ok');
    expect(r.detalhe).toMatch(/7 relatório/);
  });
});

/**
 * A chave anon é pública por construção: vai no pacote do frontend. Esta
 * checagem olha de fora — o que de fato responde ao `anon` — porque a checagem
 * por lista conhecida passava enquanto uma **view** servia 192 notas fiscais
 * reais. View não tem RLS, e não estava na lista.
 */
describe('checarExposicaoAoAnon', () => {
  /**
   * A sonda assume o papel `anon` e conta linhas, que é o que o PostgREST faz ao
   * atender a chave pública. O cliente falso responde à contagem por objeto e
   * pode recusar a troca de papel, que é o caso de "não deu para medir".
   */
  const poolFalso = (
    objetos: { nome: string; tipo: string }[],
    linhasVistasPeloAnon: Record<string, number>,
    podeTrocarDePapel = true,
  ): pg.Pool => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes('pg_class')) {
          return { rows: objetos };
        }
        if (sql.includes('set local role anon') && !podeTrocarDePapel) {
          throw new Error('permission denied to set role "anon"');
        }
        const achado = /from public\."([^"]+)"/.exec(sql);
        if (achado !== null) {
          return { rows: [{ n: linhasVistasPeloAnon[achado[1]!] ?? 0 }] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    return { connect: async () => client } as unknown as pg.Pool;
  };

  const catalogo = ['plans', 'plan_features', 'pricing_tiers', 'billing_settings', 'cfops'];

  it('aprova quando só o catálogo declarado devolve linha', async () => {
    const r = await checarExposicaoAoAnon(
      poolFalso(
        catalogo.map((nome) => ({ nome, tipo: 'tabela' })),
        Object.fromEntries(catalogo.map((nome) => [nome, 3])),
      ),
    );

    expect(r.estado).toBe('ok');
    expect(r.detalhe).toContain('5 objeto(s)');
  });

  /**
   * A view que vazava em produção: 192 notas fiscais reais respondendo à chave
   * pública. View não tem RLS e, por padrão, atravessa a das tabelas de origem.
   */
  it('acusa a view que devolve linha, dizendo que é view', async () => {
    const r = await checarExposicaoAoAnon(
      poolFalso(
        [
          { nome: 'plans', tipo: 'tabela' },
          { nome: 'sped_invoices_for_crossref', tipo: 'view' },
        ],
        { plans: 5, sped_invoices_for_crossref: 192 },
      ),
    );

    expect(r.estado).toBe('falha');
    expect(r.detalhe).toContain('sped_invoices_for_crossref (view)');
    expect(r.detalhe).toContain('qualquer pessoa na internet');
    expect(r.acao).toContain('security_invoker = on');
  });

  /**
   * Privilégio não é leitura: o Supabase concede `select` ao `anon` no schema
   * inteiro e deixa a RLS barrar as linhas. Tabela protegida devolve zero, e
   * zero não pode virar acusação — senão a checagem vira ruído e é ignorada.
   */
  it('não acusa tabela cuja RLS zera o resultado', async () => {
    const r = await checarExposicaoAoAnon(
      poolFalso(
        [
          { nome: 'clients', tipo: 'tabela' },
          { nome: 'events', tipo: 'tabela' },
        ],
        { clients: 0, events: 0 },
      ),
    );

    expect(r.estado).toBe('ok');
  });

  /**
   * "Não medi" não pode sair como "está seguro". Sem poder assumir o papel, a
   * sonda não perguntou nada — e 69 tabelas pareceriam protegidas por silêncio.
   */
  it('avisa, em vez de aprovar, quando não consegue assumir o papel anon', async () => {
    const r = await checarExposicaoAoAnon(
      poolFalso([{ nome: 'clients', tipo: 'tabela' }], { clients: 9 }, false),
    );

    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toContain('não verificado');
  });

  it('a ação manda declarar a exceção, não afrouxar a regra', async () => {
    const r = await checarExposicaoAoAnon(
      poolFalso([{ nome: 'tabela_nova', tipo: 'tabela' }], { tabela_nova: 1 }),
    );

    expect(r.acao).toContain('LEITURA_ANON_INTENCIONAL');
  });
});

/**
 * Trilha que ninguém olha é arquivo, não controle. A checagem não substitui
 * alerta em tempo real — isso precisa de um destino, e destino é decisão de quem
 * opera —, mas garante que o que está acontecendo apareça na primeira vez que
 * alguém rodar o diagnóstico.
 */
describe('checarTrilhaDeSeguranca', () => {
  /**
   * Quatro consultas em ordem: resumo por tipo, idade do mais antigo, contas sob
   * tentativa e origens recusadas. O pool falso responde na mesma ordem.
   */
  const poolFalso = (
    resumo: { kind: string; n: string }[],
    dias: number,
    contas = 0,
    origens = 0,
  ): pg.Pool => {
    const respostas = [
      { rows: resumo },
      { rows: [{ dias: String(dias) }] },
      { rows: [{ n: String(contas) }] },
      { rows: [{ n: String(origens) }] },
    ];
    let i = 0;
    return { query: async () => respostas[i++] } as unknown as pg.Pool;
  };

  it('aprova e mostra o movimento das últimas 24h', async () => {
    const r = await checarTrilhaDeSeguranca(
      poolFalso([{ kind: 'login_ok', n: '12' }, { kind: 'limite', n: '3' }], 4),
    );

    expect(r.estado).toBe('ok');
    expect(r.detalhe).toContain('login_ok=12');
  });

  /** Zero evento não é "está tudo bem": pode ser trilha desligada. */
  it('diz que não houve evento, em vez de mostrar lista vazia', async () => {
    const r = await checarTrilhaDeSeguranca(poolFalso([], 0));

    expect(r.detalhe).toContain('nenhum evento');
  });

  it('avisa quando uma conta acumula tentativas falhas', async () => {
    const r = await checarTrilhaDeSeguranca(
      poolFalso([{ kind: 'login_falhou', n: '40' }], 2, 1),
    );

    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toContain('1 conta(s)');
    expect(r.acao).toContain('INCIDENTES.md');
  });

  it('avisa quando uma origem acumula recusas', async () => {
    const r = await checarTrilhaDeSeguranca(
      poolFalso([{ kind: 'nao_autenticado', n: '300' }], 2, 0, 2),
    );

    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toContain('2 origem(ns)');
  });

  /**
   * Um expurgo que não roda não produz erro nenhum. Comparar a idade do evento
   * mais antigo com a retenção é a única forma de perceber que a política de
   * descarte virou texto.
   */
  it('avisa quando o expurgo parou de rodar', async () => {
    const r = await checarTrilhaDeSeguranca(poolFalso([{ kind: 'limite', n: '1' }], 400));

    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toContain('o expurgo não está rodando');
  });

  it('não confunde trilha jovem com expurgo parado', async () => {
    const r = await checarTrilhaDeSeguranca(poolFalso([{ kind: 'limite', n: '1' }], 30));

    expect(r.estado).toBe('ok');
  });
});

describe('checarIndicesFinanceiros', () => {
  const AGORA = new Date('2026-09-25T15:00:00Z');
  const pool = (linhas: { index_id: string; verified: boolean; pontos: string; ultimo: string | null }[]): pg.Pool =>
    ({ query: async () => ({ rows: linhas }) }) as unknown as pg.Pool;

  it('vazio: aviso com o comando de carga', async () => {
    const r = await checarIndicesFinanceiros(pool([{ index_id: 'ipca', verified: false, pontos: '0', ultimo: null }]), AGORA);
    expect(r.estado).toBe('aviso');
    expect(r.detalhe).toMatch(/sem pontos: ipca/);
    expect(r.acao).toMatch(/carregar-indices-oficiais/);
  });

  it('atrasado há mais de dois meses, ou não conferido: aviso', async () => {
    const r = await checarIndicesFinanceiros(
      pool([
        { index_id: 'ipca', verified: true, pontos: '380', ultimo: '2026-05' },
        { index_id: 'tr', verified: false, pontos: '386', ultimo: '2026-08' },
      ]),
      AGORA,
    );
    expect(r.detalhe).toMatch(/atrasados: ipca \(2026-05\)/);
    expect(r.detalhe).toMatch(/não conferidos: tr/);
  });

  it('em dia e conferido: ok, com a cobertura', async () => {
    const r = await checarIndicesFinanceiros(pool([{ index_id: 'ipca', verified: true, pontos: '386', ultimo: '2026-08' }]), AGORA);
    expect(r).toMatchObject({ estado: 'ok', detalhe: 'ipca: 386 até 2026-08' });
  });
});
