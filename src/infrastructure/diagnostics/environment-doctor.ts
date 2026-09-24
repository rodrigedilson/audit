import pg from 'pg';
import { ignorarErroDeClienteOcioso } from '../persistence/pool-errors.js';
import { loadEnv, EnvError, type Env } from '../../config/env.js';
import { CertificateVault } from '../../fiscal/portfolio/certificate-vault.js';

/**
 * Diagnóstico do ambiente: responde "por que a API não está funcionando" com
 * uma causa e uma ação, em vez de deixar o operador interpretar um stack trace
 * de `ENETUNREACH` ou uma lista de planos vazia.
 *
 * Existe porque cada um dos problemas abaixo já aconteceu de verdade nesta
 * instalação, e nenhum se anuncia: o schema aplicado pela metade devolve 200 com
 * lista vazia, e a falta de `memberships` devolve 403 em tudo.
 */

export type Estado = 'ok' | 'aviso' | 'falha';

export interface Checagem {
  nome: string;
  estado: Estado;
  detalhe: string;
  /** O que fazer. Ausente quando está tudo certo. */
  acao?: string;
}

export interface Diagnostico {
  checagens: Checagem[];
  ok: boolean;
}

/** Tabelas que as migrations criam. A ausência de qualquer uma é schema incompleto. */
const TABELAS = [
  'tenants',
  'memberships',
  'clients',
  'periods',
  'events',
  'projection_snapshots',
  'jobs',
  'certificates',
  'plans',
  'billing_settings',
  'subscriptions',
  'invoices',
  'billing_events',
  'documents',
  'document_items',
  'items',
  'item_classifications',
  'fiscal_codes',
  'cclasstrib_cst',
  'ncm_flags',
  'tax_rules',
  'assessments',
  'assessment_lines',
  'assessment_adjustments',
  'audit_trails',
  'books',
  'fisco_assessments',
  'fisco_assessment_lines',
  'assessment_divergences',
  'deadline_rules',
  'deadlines',
  'assistant_threads',
  'assistant_messages',
  'bank_statements',
  'bank_statement_lines',
  'payment_matches',
  'simulations',
  'sped_files',
  'sped_documents',
  'sped_carried_credits',
  'dfe_sync_state',
  'dfe_summaries',
  'dfe_documents',
] as const;

const FUNCOES = [
  'current_user_id',
  'is_member_of',
  'append_event',
  'billable_clients',
  'events_reject_mutation',
  'effective_classification',
  'item_propagation',
  'effective_rules',
  'portfolio_deadlines',
  'assistant_usage',
  'document_coverage',
] as const;

/** Um por migration, para dizer qual arquivo falta rodar. */
const TABELA_PARA_PASSO: Record<string, string> = {
  tenants: '01-multi-tenancy.sql',
  memberships: '01-multi-tenancy.sql',
  clients: '01-multi-tenancy.sql',
  periods: '01-multi-tenancy.sql',
  events: '01-multi-tenancy.sql',
  projection_snapshots: '01-multi-tenancy.sql',
  jobs: '01-multi-tenancy.sql',
  certificates: '02-cofre-certificados.sql',
  plans: '03-cobranca.sql',
  billing_settings: '03-cobranca.sql',
  subscriptions: '03-cobranca.sql',
  invoices: '03-cobranca.sql',
  billing_events: '03-cobranca.sql',
  documents: '04-ingestao.sql',
  document_items: '04-ingestao.sql',
  items: '05-catalogo-de-itens.sql',
  item_classifications: '05-catalogo-de-itens.sql',
  fiscal_codes: '05-catalogo-de-itens.sql',
  cclasstrib_cst: '05-catalogo-de-itens.sql',
  ncm_flags: '05-catalogo-de-itens.sql',
  tax_rules: '06-apuracao-dual.sql',
  assessments: '06-apuracao-dual.sql',
  assessment_lines: '06-apuracao-dual.sql',
  assessment_adjustments: '06-apuracao-dual.sql',
  audit_trails: '07-reporting.sql',
  books: '07-reporting.sql',
  fisco_assessments: '08-contra-apuracao.sql',
  fisco_assessment_lines: '08-contra-apuracao.sql',
  assessment_divergences: '08-contra-apuracao.sql',
  deadline_rules: '08-contra-apuracao.sql',
  deadlines: '08-contra-apuracao.sql',
  assistant_threads: '09-assistente-fiscal.sql',
  assistant_messages: '09-assistente-fiscal.sql',
  bank_statements: '10-credito-por-fornecedor.sql',
  bank_statement_lines: '10-credito-por-fornecedor.sql',
  payment_matches: '10-credito-por-fornecedor.sql',
  simulations: '11-simulador-de-regime.sql',
  sped_files: '12-dossie-saldo-credor.sql',
  sped_documents: '12-dossie-saldo-credor.sql',
  sped_carried_credits: '12-dossie-saldo-credor.sql',
  dfe_sync_state: '19-coleta-dfe.sql',
  dfe_summaries: '19-coleta-dfe.sql',
  dfe_documents: '19-coleta-dfe.sql',
};

/**
 * Isola uma checagem.
 *
 * O doutor existe para diagnosticar ambiente quebrado, e uma checagem que lança
 * derrubava o diagnóstico inteiro — foi o que aconteceu contra produção, onde
 * uma migration não aplicada deixou a coluna `key_id` ausente e a exceção matou
 * as outras onze checagens. Um diagnóstico que morre na primeira surpresa não
 * diagnostica nada.
 */
async function isolar(nome: string, checagem: () => Promise<Checagem>): Promise<Checagem> {
  try {
    return await checagem();
  } catch (erro) {
    return {
      nome,
      estado: 'falha',
      detalhe: erro instanceof Error ? erro.message : String(erro),
      acao:
        'A checagem quebrou. Em geral é migration não aplicada ou permissão —\n' +
        '  compare a lista de tabelas acima com supabase/migrations/.',
    };
  }
}

export async function diagnosticar(source: NodeJS.ProcessEnv = process.env): Promise<Diagnostico> {
  const checagens: Checagem[] = [];

  let env: Env;
  try {
    env = loadEnv(source);
    checagens.push({
      nome: 'variáveis de ambiente',
      estado: 'ok',
      detalhe: [
        `ambiente ${env.environment}`,
        `banco configurado`,
        env.supabase.jwksUrl ? 'JWT por JWKS' : 'JWT por segredo HS256',
        `cofre A1 com chave de ${env.certificateMasterKey.length} caracteres`,
        env.anthropic === undefined
          ? 'assistente só na camada 1'
          : `assistente camada 3 com ${env.anthropic.model}`,
      ].join(' · '),
    });
  } catch (erro) {
    checagens.push({
      nome: 'variáveis de ambiente',
      estado: 'falha',
      detalhe: erro instanceof EnvError ? erro.message : descrever(erro),
      acao: 'Preencha o .env. Ver docs/setup/SUPABASE.md, passo 3.',
    });
    return { checagens, ok: false };
  }

  // Timeout curto de propósito: um diagnóstico que pendura não diagnostica
  // nada. Host inalcançável tem de virar mensagem em segundos, não em minutos.
  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 8_000,
  });
  // O doutor existe para diagnosticar banco com problema: morrer com exceção
  // não capturada quando o banco encerra a conexão seria falhar exatamente na
  // situação para a qual ele foi feito.
  ignorarErroDeClienteOcioso(pool, 'DoctorPool');

  try {
    const conexao = await checarConexao(pool);
    checagens.push(conexao);
    if (conexao.estado === 'falha') {
      return { checagens, ok: false };
    }

    const tabelas = await checarTabelas(pool);
    checagens.push(tabelas);
    checagens.push(await checarFuncoes(pool));
    checagens.push(await checarAppendOnly(pool));

    // As duas últimas consultam as tabelas. Sem schema, elas estourariam com
    // `relation "plans" does not exist` e esconderiam o diagnóstico real, que é
    // justamente o schema faltando.
    if (tabelas.estado === 'falha') {
      checagens.push({
        nome: 'carga inicial e escritório',
        estado: 'aviso',
        detalhe: 'não verificado: depende do schema',
        acao: 'Aplique as migrations e rode `npm run doctor` de novo.',
      });
      return { checagens, ok: false };
    }

    checagens.push(await isolar('carga inicial', () => checarCargaInicial(pool)));
    checagens.push(await isolar('trilhas de auditoria', () => checarTrilhas(pool)));
    checagens.push(
      await isolar('visibilidade das tabelas públicas', () =>
        checarVisibilidadePublica(pool),
      ),
    );
    checagens.push(
      await isolar('tabelas oficiais de códigos', () => checarTabelasOficiais(pool)),
    );
    checagens.push(
      await isolar('cofre de certificados A1', () => checarCofreDeCertificados(pool, env)),
    );
    checagens.push(
      await isolar('regras de creditamento', () => checarRegrasPublicadas(pool)),
    );
    checagens.push(await isolar('prazos normativos', () => checarPrazosNormativos(pool)));
    checagens.push(await isolar('cota do assistente', () => checarCotaDoAssistente(pool)));
    checagens.push(await isolar('cobrança (Asaas)', () => checarCobranca(pool, env)));
    checagens.push(await isolar('escritório e usuário', () => checarEscritorio(pool)));
  } finally {
    await pool.end().catch(() => undefined);
  }

  return { checagens, ok: checagens.every((c) => c.estado !== 'falha') };
}

async function checarConexao(pool: pg.Pool): Promise<Checagem> {
  try {
    const { rows } = await pool.query<{ versao: string; base: string }>(
      'select version() as versao, current_database() as base',
    );
    return {
      nome: 'conexão com o banco',
      estado: 'ok',
      detalhe: `${rows[0]!.versao.split(' ').slice(0, 2).join(' ')} · base ${rows[0]!.base}`,
    };
  } catch (erro) {
    return classificarFalhaDeConexao(descrever(erro));
  }
}

/**
 * Traduz a falha de conexão na ação correspondente.
 *
 * Função separada e exportada porque é a parte que importa — o mapeamento de
 * erro para conduta — e porque reproduzir cada condição de rede dentro de um
 * teste é frágil: um literal IPv6 sem rota dá ENOTFOUND no resolvedor, não o
 * ENETUNREACH que o host real produz.
 */
export function classificarFalhaDeConexao(causa: string): Checagem {
  const base = { nome: 'conexão com o banco', estado: 'falha' as const, detalhe: causa };

  if (causa.includes('ENETUNREACH') || causa.includes('EHOSTUNREACH')) {
    return {
      ...base,
      acao:
        'O host não é alcançável desta máquina. O host de conexão direta do Supabase\n' +
        '  (db.<ref>.supabase.co) só tem endereço IPv6; confirme com\n' +
        '  `getent ahostsv4 db.<ref>.supabase.co` e `ip -6 route show default`.\n' +
        '\n' +
        '  Use o pooler, que atende em IPv4. O hostname não é previsível — o\n' +
        '  prefixo varia entre aws-0 e aws-1 — então descubra o seu com:\n' +
        '    npm run pooler -- SEU-PROJECT-REF',
    };
  }

  if (causa.includes('ENOTFOUND') || causa.includes('EAI_AGAIN')) {
    return {
      ...base,
      acao:
        'O host não resolve no DNS. Confira o nome em DATABASE_URL — normalmente é\n' +
        '  erro de digitação no project-ref, ou o endereço do pooler com a região errada.',
    };
  }

  if (causa.includes('password authentication failed')) {
    return {
      ...base,
      acao:
        'Senha incorreta, ou caractere especial sem URL-encode (@ = %40, # = %23).\n' +
        '  Redefina em Project Settings → Database → Reset database password.',
    };
  }

  if (causa.includes('ETIMEDOUT') || causa.includes('timeout')) {
    return {
      ...base,
      acao:
        'Conexão expirou. Normalmente firewall no caminho, ou a porta errada —\n' +
        '  5432 para conexão direta e session pooler, 6543 para transaction pooler.',
    };
  }

  if (causa.includes('does not exist')) {
    return {
      ...base,
      acao: 'O banco indicado no fim da DATABASE_URL não existe. No Supabase é `postgres`.',
    };
  }

  return { ...base, acao: 'Confira DATABASE_URL.' };
}

async function checarTabelas(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])`,
    [[...TABELAS]],
  );

  const presentes = new Set(rows.map((r) => r.table_name));
  const faltando = TABELAS.filter((t) => !presentes.has(t));

  if (faltando.length === 0) {
    return { nome: 'schema', estado: 'ok', detalhe: `${TABELAS.length} tabelas` };
  }

  const passos = [...new Set(faltando.map((t) => TABELA_PARA_PASSO[t]))].sort();

  return {
    nome: 'schema',
    estado: 'falha',
    detalhe: `faltam ${faltando.length} de ${TABELAS.length}: ${faltando.join(', ')}`,
    acao: `Rode em scripts/sql/migracoes/: ${passos.join(', ')}`,
  };
}

async function checarFuncoes(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ routine_name: string }>(
    `select routine_name from information_schema.routines
      where routine_schema = 'public' and routine_name = any($1::text[])`,
    [[...FUNCOES]],
  );

  const presentes = new Set(rows.map((r) => r.routine_name));
  const faltando = FUNCOES.filter((f) => !presentes.has(f));

  return faltando.length === 0
    ? { nome: 'funções', estado: 'ok', detalhe: FUNCOES.join(', ') }
    : {
        nome: 'funções',
        estado: 'falha',
        detalhe: `faltam: ${faltando.join(', ')}`,
          acao:
          'Reaplique os passos de scripts/sql/migracoes/ — as funções vêm de\n' +
          '  01-multi-tenancy.sql, 03-cobranca.sql e 05-catalogo-de-itens.sql.',
      };
}

/**
 * O trigger que torna `events` append-only é o que impede reescrever a história
 * com um UPDATE. Sem ele o replay passaria a "provar" um número adulterado, e o
 * produto inteiro perde o sentido — por isso é falha, não aviso.
 */
async function checarAppendOnly(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ total: string }>(
    `select count(*)::text as total from pg_trigger
      where tgname = 'events_append_only' and not tgisinternal`,
  );

  return Number(rows[0]!.total) > 0
    ? { nome: 'event log append-only', estado: 'ok', detalhe: 'trigger events_append_only ativo' }
    : {
        nome: 'event log append-only',
        estado: 'falha',
        detalhe: 'trigger events_append_only ausente: UPDATE e DELETE em events não estão bloqueados',
        acao: 'Reaplique scripts/sql/migracoes/01-multi-tenancy.sql.',
      };
}

/**
 * Carga inicial de `plans` e `billing_settings`. Sem ela a calculadora de preço
 * pública devolve lista vazia sem erro, e a fatura falha só no fechamento do
 * mês — é o tipo de problema que não se anuncia.
 */
async function checarCargaInicial(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ planos: string; parametros: string }>(
    `select (select count(*)::text from plans)            as planos,
            (select count(*)::text from billing_settings) as parametros`,
  );

  const planos = Number(rows[0]!.planos);
  const parametros = Number(rows[0]!.parametros);

  if (planos >= 5 && parametros >= 1) {
    return {
      nome: 'carga inicial de cobrança',
      estado: 'ok',
      detalhe: `${planos} planos, parâmetros carregados`,
    };
  }

  return {
    nome: 'carga inicial de cobrança',
    estado: 'falha',
    detalhe: `${planos} planos (esperado 5), ${parametros} linha(s) de parâmetros (esperado 1)`,
    acao:
      'Os INSERT de carga não entraram. Reaplique\n' +
      '  scripts/sql/migracoes/03-cobranca.sql — é idempotente,\n' +
      '  os `on conflict do nothing` evitam duplicar.',
  };
}

/**
 * Cota do assistente nos planos.
 *
 * Falha, e não aviso: a coluna existir com zero em toda linha significa que o
 * `UPDATE` de carga da migration não rodou, e o efeito é o assistente responder
 * `403` para todos os clientes — um recurso contratado que simplesmente não
 * aparece, sem erro em log nenhum. Zero é valor legítimo para MEI e Simples
 * integrado, então a checagem olha se **algum** plano tem cota.
 */
export async function checarCotaDoAssistente(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ com_cota: string; total: string }>(
    `select count(*) filter (where assistant_messages_per_month > 0)::text as com_cota,
            count(*)::text as total
       from plans`,
  );

  const comCota = Number(rows[0]!.com_cota);

  if (comCota > 0) {
    return {
      nome: 'cota do assistente',
      estado: 'ok',
      detalhe: `${comCota} de ${rows[0]!.total} planos com assistente incluído`,
    };
  }

  return {
    nome: 'cota do assistente',
    estado: 'falha',
    detalhe: 'nenhum plano com cota de assistente',
    acao:
      'O `UPDATE` de carga não rodou: o assistente vai responder 403 para todos os\n' +
      '  clientes, sem erro em log nenhum. Reaplique\n' +
      '  scripts/sql/migracoes/09-assistente-fiscal.sql — é idempotente.',
  };
}

/**
 * Cobrança: schema da ativação e gateway do ambiente.
 *
 * É o registro do que falta para cobrar de verdade. Em prod, sem as chaves do
 * Asaas, a cobrança roda em modo "só cálculo" e a ativação responde 503. Isso é
 * aviso, não falha: o produto funciona, mas não fatura, e a lista do que
 * configurar precisa aparecer a cada `doctor`, e não depender de alguém lembrar.
 *
 * Em dev, chave do Asaas é o erro: o banco é o de produção, e o sandbox
 * gravaria IDs de cliente e de assinatura falsos nas tabelas de cobrança reais.
 */
export async function checarCobranca(pool: pg.Pool, env: Env): Promise<Checagem> {
  const nome = 'cobrança (Asaas)';
  const { rows } = await pool.query<{ colunas: string; ativadas: string | null }>(
    `select (select count(*) from information_schema.columns
              where table_schema = 'public' and table_name = 'subscriptions'
                and column_name in ('billing_document', 'billing_email', 'billing_type', 'activated_at'))::text
              as colunas,
            (select count(*) from subscriptions where asaas_subscription_id is not null)::text as ativadas`,
  );

  if (Number(rows[0]!.colunas) < 4) {
    return {
      nome,
      estado: 'falha',
      detalhe: 'schema da ativação ausente em subscriptions',
      acao:
        'A ativação da cobrança vai falhar ao gravar os dados do pagador. Aplique\n' +
        '  scripts/sql/migracoes/17-ativacao-da-cobranca.sql — é idempotente.',
    };
  }

  const ativadas = Number(rows[0]!.ativadas ?? 0);

  if (env.environment === 'dev') {
    return env.asaas === undefined
      ? {
          nome,
          estado: 'ok',
          detalhe: 'dev sem gateway, como deve: o banco é o de produção, e a cobrança é testada com dublê',
        }
      : {
          nome,
          estado: 'aviso',
          detalhe: 'dev com ASAAS_API_KEY',
          acao:
            'Tire a chave do config dev: com o banco compartilhado, o sandbox grava IDs\n' +
            '  falsos nas tabelas de cobrança de produção. Ver docs/setup/SEGREDOS.md.',
        };
  }

  if (env.asaas === undefined) {
    return {
      nome,
      estado: 'aviso',
      detalhe: 'modo só cálculo: sem ASAAS_API_KEY, a ativação responde 503 e nada é faturado',
      acao:
        'Para cobrar (docs/setup/SEGREDOS.md, seção Cobrança):\n' +
        '  1. ASAAS_API_KEY, ASAAS_BASE_URL=https://api.asaas.com/v3 e ASAAS_WEBHOOK_TOKEN no Doppler prd;\n' +
        '  2. webhook /v1/webhooks/asaas no painel do Asaas, com o mesmo token;\n' +
        '  3. conferir no sandbox o ajuste de valor de cobrança gerada por assinatura.',
    };
  }

  return {
    nome,
    estado: 'ok',
    detalhe: `gateway configurado · ${ativadas} escritório(s) com cobrança ativada`,
  };
}

/**
 * Prazos normativos carregados.
 *
 * Aviso, não falha: o calendário funciona sem eles e entrega as pendências
 * derivadas do estado do sistema, que são fatos nossos. O que não sai é prazo de
 * norma — e a lista vazia de prazos precisa ser lida como "nada carregado", não
 * como "nada a vencer". É a mesma razão de `tax_rules` nascer vazia.
 */
export async function checarPrazosNormativos(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ total: string }>(
    `select count(*)::text as total
       from deadline_rules
      where active and nature = 'normativo'`,
  );

  const total = Number(rows[0]!.total);

  if (total > 0) {
    return { nome: 'prazos normativos', estado: 'ok', detalhe: `${total} regra(s) ativa(s)` };
  }

  return {
    nome: 'prazos normativos',
    estado: 'aviso',
    detalhe: 'nenhum prazo normativo em deadline_rules',
    acao:
      'O calendário entrega as pendências derivadas do estado do sistema, mas\n' +
      '  nenhum prazo de norma. `GET /v1/deadlines` devolve\n' +
      '  `normative_rules_loaded: false` justamente para a tela não ler a lista\n' +
      '  vazia como "nada a vencer". Carregue os prazos em deadline_rules com a\n' +
      '  base legal — a coluna é obrigatória de propósito.',
  };
}

/**
 * Catálogo de trilhas de auditoria.
 *
 * Um `audit_trails` vazio não falha nada em runtime: o relatório volta com zero
 * trilhas e o Book sai com a seção em branco. O escritório concluiria que está
 * tudo certo com o cliente, quando nada foi conferido — é a pior forma de erro
 * que este produto pode ter.
 */
export async function checarTrilhas(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ total: string }>(
    'select count(*)::text as total from audit_trails where active',
  );

  const total = Number(rows[0]!.total);

  if (total >= 12) {
    return { nome: 'trilhas de auditoria', estado: 'ok', detalhe: `${total} trilhas ativas` };
  }

  return {
    nome: 'trilhas de auditoria',
    estado: 'falha',
    detalhe: `${total} trilhas ativas (esperado 12 ou mais)`,
    acao:
      'Sem catálogo, o Book sai sem nenhuma verificação nomeada e parece aprovado.\n' +
      '  Reaplique scripts/sql/migracoes/07-reporting.sql — é idempotente.',
  };
}

/**
 * Visibilidade das tabelas públicas.
 *
 * `plans` e `billing_settings` alimentam a calculadora de preço, que é pública.
 * Elas têm de estar com RLS **desligado**: com RLS ligada e sem policy, a API
 * REST devolve `200` com lista vazia — nem erro, nem dado. A calculadora
 * simplesmente mostra nada, e ninguém descobre por quê.
 *
 * Esta checagem existe porque aconteceu: os 5 planos estavam na tabela e a API
 * devolvia `[]`. O `disable row level security` da migration não estava em
 * efeito, e o sintoma (200 com lista vazia, não 403) só aponta RLS para quem
 * já conhece a diferença.
 */
async function checarVisibilidadePublica(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ tabela: string; rls: boolean; policies: string }>(
    `select c.relname as tabela,
            c.relrowsecurity as rls,
            (select count(*)::text from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname in ('plans', 'billing_settings')`,
  );

  const bloqueadas = rows.filter((r) => r.rls && Number(r.policies) === 0);

  if (bloqueadas.length === 0) {
    return {
      nome: 'visibilidade das tabelas públicas',
      estado: 'ok',
      detalhe: rows.map((r) => `${r.tabela}=${r.rls ? 'rls_on' : 'rls_off'}`).join(', '),
    };
  }

  return {
    nome: 'visibilidade das tabelas públicas',
    estado: 'falha',
    detalhe:
      `${bloqueadas.map((r) => r.tabela).join(', ')} com RLS ligada e sem policy: ` +
      'a API REST devolve lista vazia, não erro',
    acao:
      'Rode scripts/sql/reparo-planos.sql, que desliga o RLS dessas duas e concede\n' +
      '  select a anon. Sem isso a calculadora de preço pública mostra nada, e o\n' +
      '  sintoma não aponta a causa: seriam 403 se fosse permissão.',
  };
}

/**
 * Tabelas oficiais de códigos (NCM, CFOP, CST, cClassTrib).
 *
 * É **aviso**, não falha: a API sobe e funciona sem elas. Mas a saúde do
 * cadastro passa a reportar "não verificado" em vez de "ok", porque validar
 * contra tabela vazia aprovaria qualquer código — o que é pior do que não
 * validar. O aviso existe para que essa lacuna não passe por aprovação.
 */
/** Os tipos que a camada 3 confere. A validação é por tipo, e o relato também. */
const TIPOS_DE_CODIGO = [
  'ncm',
  'nbs',
  'cfop',
  'cst_icms',
  'cst_pis_cofins',
  'cst_ibs_cbs',
  'cclasstrib',
] as const;

/**
 * Tabelas oficiais, por tipo.
 *
 * Relatava só dois números — total de códigos e de pares — e com a tabela de
 * CFOP carregada isso virou inútil: "238 códigos" não diz de quais tipos, e o
 * `aviso` pedia carregar tudo sem dizer o que falta. A validação é por tipo, e o
 * `not_verified` também: quem roda o doutor quer saber qual tipo ainda não
 * confere nada.
 */
async function checarTabelasOficiais(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ kind: string; n: string }>(
    `select kind, count(*)::text as n from fiscal_codes group by kind
     union all
     select 'cclasstrib_cst_pares', count(*)::text from cclasstrib_cst
     union all
     select 'ncm_flags', count(*)::text from ncm_flags`,
  );

  const contagem = new Map(rows.map((linha) => [linha.kind, Number(linha.n)]));
  const carregados = TIPOS_DE_CODIGO.filter((tipo) => (contagem.get(tipo) ?? 0) > 0);
  const vazios = TIPOS_DE_CODIGO.filter((tipo) => (contagem.get(tipo) ?? 0) === 0);
  const pares = contagem.get('cclasstrib_cst_pares') ?? 0;

  const detalhe =
    `${carregados.length} de ${TIPOS_DE_CODIGO.length} tipos carregados` +
    (carregados.length > 0
      ? ` (${carregados.map((t) => `${t}: ${contagem.get(t)}`).join(', ')})`
      : '') +
    ` · ${pares} pares cClassTrib×CST · ${contagem.get('ncm_flags') ?? 0} NCM marcados`;

  if (vazios.length === 0 && pares > 0) {
    return { nome: 'tabelas oficiais de códigos', estado: 'ok', detalhe };
  }

  return {
    nome: 'tabelas oficiais de códigos',
    estado: 'aviso',
    detalhe,
    acao:
      `Sem tabela, o tipo reporta "não verificado" em vez de "ok" — de propósito,\n` +
      `  porque validar contra tabela vazia aprovaria qualquer código.\n` +
      `  Falta: ${[...vazios, ...(pares === 0 ? ['pares cClassTrib×CST'] : [])].join(', ')}.\n` +
      '  CFOP sai da tabela `cfops`: npx tsx scripts/carregar-cfop-oficial.ts',
  };
}

/**
 * Cofre de certificados e a chave que os cifra.
 *
 * É a verificação pós-rotação que não depende do secret manager: um comando diz
 * se sobrou certificado na chave antiga. Sem ela, a única forma de descobrir
 * seria tentar usar o certificado — e descobrir no momento em que a coleta de
 * DF-e falha.
 */
async function checarCofreDeCertificados(pool: pg.Pool, env: Env): Promise<Checagem> {
  /**
   * `key_id` vem de uma migration própria, e o doutor roda contra banco que
   * pode não tê-la aplicado — foi o caso em produção. Sem esta checagem, a
   * consulta lançava `column "key_id" does not exist` e a ausência de uma
   * migration aparecia como quebra do diagnóstico em vez de achado.
   */
  const { rows: coluna } = await pool.query<{ existe: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'certificates'
          and column_name = 'key_id'
     ) as existe`,
  );

  if (coluna[0]?.existe !== true) {
    const { rows: quantos } = await pool.query<{ n: string }>(
      'select count(*)::text as n from certificates',
    );

    return {
      nome: 'cofre de certificados A1',
      estado: 'aviso',
      detalhe: `${quantos[0]?.n ?? 0} certificado(s), e a coluna key_id não existe`,
      acao:
        'Aplique a migration do key_id (passo 14 do SUPABASE.md). Sem ela não há\n' +
        '  como saber qual chave mestra cifrou cada certificado, e a rotação da\n' +
        '  chave deixa de ser conferível.',
    };
  }

  const { rows } = await pool.query<{ key_id: string | null; n: string }>(
    'select key_id, count(*)::text as n from certificates group by key_id',
  );

  const total = rows.reduce((soma, linha) => soma + Number(linha.n), 0);

  if (total === 0) {
    return {
      nome: 'cofre de certificados A1',
      estado: 'ok',
      detalhe:
        'nenhum certificado guardado — rotacionar a chave mestra agora é sem custo, ' +
        'e depois não é',
    };
  }

  let atual: string;
  try {
    atual = new CertificateVault(env.certificateMasterKey, env.certificateMasterKeyPrevious).keyId;
  } catch (erro) {
    return {
      nome: 'cofre de certificados A1',
      estado: 'falha',
      detalhe: erro instanceof Error ? erro.message : String(erro),
      acao: 'Corrija CERTIFICATE_MASTER_KEY antes de qualquer operação com certificado.',
    };
  }

  const foraDaAtual = rows
    .filter((linha) => linha.key_id !== atual)
    .reduce((soma, linha) => soma + Number(linha.n), 0);

  if (foraDaAtual === 0) {
    return {
      nome: 'cofre de certificados A1',
      estado: 'ok',
      detalhe: `${total} certificado(s), todos na chave ${atual}`,
    };
  }

  return {
    nome: 'cofre de certificados A1',
    estado: 'aviso',
    detalhe: `${total} certificado(s), ${foraDaAtual} fora da chave atual (${atual})`,
    acao:
      'Rotação incompleta. Rode `npx tsx scripts/recifrar-certificados.ts --executar`\n' +
      '  e NÃO remova CERTIFICATE_MASTER_KEY_PREVIOUS enquanto sobrar linha aqui:\n' +
      '  esses certificados só abrem com ela.',
  };
}

/**
 * Regras de creditamento publicadas.
 *
 * Aviso, não falha: a apuração roda sem elas e entrega débito e crédito
 * potencial — o que já é a "Base Espelho" dos documentos. O que não sai é o
 * valor devido, que vem `null` com o motivo em vez de um número assumido.
 */
async function checarRegrasPublicadas(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ total: string; tributos: string | null }>(
    `select count(*)::text as total,
            string_agg(distinct tax, ', ' order by tax) as tributos
       from tax_rules
      where kind = 'credit_share'
        and (valid_to is null or valid_to >= current_date)`,
  );

  const total = Number(rows[0]!.total);

  if (total > 0) {
    return {
      nome: 'regras de creditamento',
      estado: 'ok',
      detalhe: `${total} vigentes: ${rows[0]!.tributos}`,
    };
  }

  return {
    nome: 'regras de creditamento',
    estado: 'aviso',
    detalhe: 'nenhuma regra vigente em tax_rules',
    acao:
      'A apuração roda e entrega débito e crédito potencial, mas o valor devido\n' +
      '  vem nulo com o motivo — de propósito, porque decidir se um crédito é\n' +
      '  aproveitável depende de norma, e um número fiscal errado é pior do que\n' +
      '  um ausente. Publique as regras em tax_rules com a fonte normativa.',
  };
}

/**
 * Sem um `membership`, a API responde 403 em tudo: o tenant é resolvido pela
 * tabela, nunca por um claim do token.
 */
async function checarEscritorio(pool: pg.Pool): Promise<Checagem> {
  const { rows } = await pool.query<{ escritorios: string; owners: string }>(
    `select (select count(*)::text from tenants) as escritorios,
            (select count(*)::text from memberships where role = 'owner') as owners`,
  );

  const escritorios = Number(rows[0]!.escritorios);
  const owners = Number(rows[0]!.owners);

  if (escritorios > 0 && owners > 0) {
    return {
      nome: 'escritório e usuário',
      estado: 'ok',
      detalhe: `${escritorios} escritório(s), ${owners} owner(s)`,
    };
  }

  return {
    nome: 'escritório e usuário',
    estado: 'falha',
    detalhe: `${escritorios} escritório(s), ${owners} owner(s)`,
    acao:
      'Rode scripts/sql/migracoes/05-bootstrap-escritorio.sql, editando as\n' +
      '  duas linhas marcadas com CONFIGURE. O usuário precisa existir antes em\n' +
      '  auth.users (Authentication → Users → Add user, com "Auto Confirm User").',
  };
}

function descrever(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
