#!/usr/bin/env tsx
/**
 * Gera `scripts/sql/setup-completo.sql`: um único arquivo para colar no SQL
 * Editor do Supabase, com todas as migrations mais o bootstrap do escritório.
 *
 * É gerado, e não escrito à mão, porque uma cópia manual das migrations
 * divergiria na primeira alteração — e a divergência só apareceria quando o
 * banco de produção deixasse de bater com o que os testes exercitam.
 *
 *   npm run sql:bundle
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');
const SAIDA = join(process.cwd(), 'scripts/sql/setup-completo.sql');

const CABECALHO = `-- =============================================================================
-- audit — setup completo do Supabase
--
-- ARQUIVO GERADO. Não edite aqui: altere as migrations em supabase/migrations/
-- e rode \`npm run sql:bundle\`. Editar este arquivo faria o banco divergir do
-- que a suíte de testes exercita.
--
-- COMO USAR
--   1. Crie seu usuário antes: Authentication → Users → Add user,
--      marcando "Auto Confirm User". Este projeto está com mailer_autoconfirm
--      desligado, então um cadastro comum fica pendente e o login falha.
--   2. Edite as duas linhas marcadas com CONFIGURE, lá embaixo na PARTE 2.
--   3. Cole o arquivo inteiro no SQL Editor e execute.
--
-- É IDEMPOTENTE: pode rodar de novo sem duplicar nada. Objetos usam
-- \`if not exists\`, e o bootstrap não cria um segundo escritório para quem já
-- tem um.
--
-- O QUE CRIA no schema public:
--   tabelas  tenants, memberships, clients, periods, events,
--            projection_snapshots, jobs, certificates, plans,
--            billing_settings, subscriptions, invoices, billing_events,
--            documents, document_items
--   funções  current_user_id, is_member_of, append_event, billable_clients,
--            events_reject_mutation
--   RLS      ligado em todas as tabelas com tenant_id, apenas policies de
--            SELECT. Sem policy de escrita, todo write vindo do cliente é
--            negado; a API escreve com a service role. O RLS aqui é a segunda
--            tranca: toda escrita fiscal passa pelo pipeline de 7 camadas, e um
--            INSERT direto burlaria isso.
-- =============================================================================

`;

const BOOTSTRAP = `

-- =============================================================================
-- PARTE 2 — bootstrap do escritório
--
-- Vincula um usuário do Supabase Auth a um escritório, como owner. Sem isso a
-- API responde 403 em tudo: o tenant é resolvido pela tabela \`memberships\`, e
-- nunca por um claim do token — um claim fica velho quando alguém sai do
-- escritório, e a sessão antiga continuaria valendo.
-- =============================================================================

do $bootstrap$
declare
  -- ┌──────────────────────────── CONFIGURE ────────────────────────────┐
  v_email       text := 'voce@seudominio.com.br';
  v_escritorio  text := 'Meu Escritório de Contabilidade';
  -- └───────────────────────────────────────────────────────────────────┘

  v_user_id     uuid;
  v_confirmado  boolean;
  v_tenant_id   uuid;
  v_existente   text;
begin
  select id, email_confirmed_at is not null
    into v_user_id, v_confirmado
    from auth.users
   where lower(email) = lower(v_email);

  if v_user_id is null then
    raise exception using
      message = format('Nenhum usuário com e-mail %L em auth.users.', v_email),
      hint = 'Crie em Authentication → Users → Add user, marcando "Auto Confirm User".';
  end if;

  if not v_confirmado then
    raise warning 'E-mail % ainda não confirmado: o login vai falhar até confirmar.', v_email;
  end if;

  select t.name into v_existente
    from memberships m join tenants t on t.id = m.tenant_id
   where m.user_id = v_user_id
   limit 1;

  if v_existente is not null then
    raise notice 'Usuário já pertence a %. Nada a criar.', v_existente;
    return;
  end if;

  insert into tenants (name) values (v_escritorio) returning id into v_tenant_id;
  insert into memberships (tenant_id, user_id, role)
       values (v_tenant_id, v_user_id, 'owner');

  raise notice 'Escritório % criado; % vinculado como owner.', v_escritorio, v_email;
end
$bootstrap$;

-- =============================================================================
-- PARTE 3 — conferência
--
-- Deve devolver uma linha com o seu e-mail e o papel owner.
-- =============================================================================

select
  t.id            as tenant_id,
  t.name          as escritorio,
  t.plan          as plano,
  u.email         as usuario,
  m.role          as papel,
  (select count(*) from plans)   as planos_carregados,
  (select minimum_cents from billing_settings where id) as minimo_centavos
from memberships m
join tenants t on t.id = m.tenant_id
join auth.users u on u.id = m.user_id
order by m.created_at desc
limit 5;
`;

async function main(): Promise<void> {
  // Ordem lexicográfica é a cronológica: os arquivos têm prefixo de timestamp, e
  // aplicar fora de ordem quebraria as chaves estrangeiras.
  const arquivos = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();

  const partes: string[] = [CABECALHO];
  partes.push(
    '-- =============================================================================\n' +
      `-- PARTE 1 — migrations (${arquivos.length} arquivos, na ordem de aplicação)\n` +
      '-- =============================================================================\n',
  );

  for (const arquivo of arquivos) {
    partes.push(
      `\n\n-- ─────────────────────────────────────────────────────────────────────────\n` +
        `-- supabase/migrations/${arquivo}\n` +
        `-- ─────────────────────────────────────────────────────────────────────────\n\n`,
    );
    partes.push(await readFile(join(MIGRATIONS_DIR, arquivo), 'utf8'));
  }

  partes.push(BOOTSTRAP);

  const conteudo = partes.join('');
  await writeFile(SAIDA, conteudo, 'utf8');

  console.log(`gerado: scripts/sql/setup-completo.sql`);
  console.log(`  migrations: ${arquivos.length}`);
  console.log(`  linhas:     ${conteudo.split('\n').length}`);
  console.log(`  tamanho:    ${(Buffer.byteLength(conteudo) / 1024).toFixed(1)} KB`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
