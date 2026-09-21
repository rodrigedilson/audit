import pg from 'pg';
import { loadEnv, EnvError, type Env } from '../../config/env.js';

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
] as const;

const FUNCOES = [
  'current_user_id',
  'is_member_of',
  'append_event',
  'billable_clients',
  'events_reject_mutation',
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
};

export async function diagnosticar(source: NodeJS.ProcessEnv = process.env): Promise<Diagnostico> {
  const checagens: Checagem[] = [];

  let env: Env;
  try {
    env = loadEnv(source);
    checagens.push({
      nome: 'variáveis de ambiente',
      estado: 'ok',
      detalhe: [
        `banco configurado`,
        env.supabase.jwksUrl ? 'JWT por JWKS' : 'JWT por segredo HS256',
        `cofre A1 com chave de ${env.certificateMasterKey.length} caracteres`,
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

    checagens.push(await checarCargaInicial(pool));
    checagens.push(await checarEscritorio(pool));
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
        '  Saídas: usar um host do pooler (IPv4), habilitar IPv6 na máquina,\n' +
        '  contratar o add-on de IPv4, ou rodar a API onde haja IPv6.',
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
    detalhe: `faltam ${faltando.length} tabelas: ${faltando.join(', ')}`,
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
        acao: 'Reaplique scripts/sql/migracoes/01-multi-tenancy.sql e 03-cobranca.sql.',
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
