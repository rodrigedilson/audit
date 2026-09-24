-- =============================================================================
-- audit — passo 7 de 25: reporting
--
-- Catálogo das 12 trilhas de auditoria e a tabela do Book de fechamento.
-- As trilhas semeadas são exatamente as checagens que ESTE sistema
-- executa, e não uma lista de verificações da RFB. Os bytes do PDF ficam
-- guardados: o Book carrega um hash no rodapé e regerá-lo depois de uma
-- regra mudar produziria outro arquivo com o mesmo número.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260921140000_reporting.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- Onda 7 — trilhas de auditoria e Book de fechamento (diferencial #3)
--
-- É o primeiro entregável que o escritório manda ao cliente final: tangibiliza
-- a saúde do cadastro e a apuração dual num documento assinado pelo hash.
--
-- NOTA DE HONESTIDADE SOBRE AS TRILHAS
-- O briefing cita o "Book de Auditorias (15+ verificações que a RFB faz)" do
-- concorrente como algo a copiar. As trilhas semeadas aqui NÃO são uma lista de
-- verificações da RFB: são exatamente as checagens que ESTE sistema executa,
-- cada uma amarrada a uma camada do pipeline e a um motivo de rejeição que
-- existe no código. Nomear uma trilha que o produto não verifica seria vender
-- conferência que não acontece.
-- =============================================================================

create table if not exists public.audit_trails (
  trail_id         text primary key,
  name             text not null,
  description      text not null,

  -- Camada do pipeline que detecta (1 parse … 7 verification-gate). Nula quando
  -- a trilha não nasce do pipeline, e sim do ciclo da competência.
  layer            smallint check (layer between 1 and 7),
  default_severity text not null check (default_severity in ('low','medium','high','critical')),
  tax_scope        text not null check (tax_scope in ('legacy','reform','both','none')),

  -- Nulo = vale para todos os regimes.
  applies_to_regimes public.regime[],

  -- Origem do dado que alimenta a trilha, para o Book explicar de onde vem.
  source           text not null check (source in (
                     'output_rejected', 'item_classification', 'assessment', 'period_state'
                   )),
  -- Chave que liga a trilha ao motivo registrado na origem.
  matches          text[] not null default '{}',
  active           boolean not null default true
);

comment on table public.audit_trails is
  'Catálogo de trilhas. Cada uma corresponde a uma checagem que o sistema executa de fato.';

insert into public.audit_trails
  (trail_id, name, description, layer, default_severity, tax_scope, source, matches) values

  ('xml_malformado',
   'XML malformado',
   'Arquivo recusado na leitura: não é XML válido. Documento não entrou na apuração.',
   1, 'critical', 'none', 'output_rejected', array['schema_violation']),

  ('chave_inconsistente',
   'Chave de acesso inconsistente com o documento',
   'Dígito verificador inválido, ou CNPJ do emitente divergente do que está na chave. '
   'Indica documento remontado ou chave de outra nota colada no arquivo.',
   2, 'critical', 'none', 'output_rejected', array['schema_violation']),

  ('documento_duplicado',
   'Documento recebido em duplicidade',
   'A mesma chave de acesso foi enviada mais de uma vez. Só a primeira entrou na '
   'apuração; contar duas vezes dobraria débito ou crédito.',
   2, 'medium', 'both', 'output_rejected', array['duplicate_document']),

  ('cclasstrib_vs_cst',
   'cClassTrib incompatível com CST-IBS/CBS',
   'Os dois códigos existem isoladamente, mas a combinação é inválida. É o erro de '
   'mérito que a SEFAZ autoriza na emissão e a apuração pune.',
   3, 'critical', 'reform', 'item_classification', array['code_incompatible']),

  ('codigo_inexistente',
   'Código fora da tabela oficial',
   'NCM, CFOP, NBS ou CST que não existe na tabela vigente.',
   3, 'high', 'both', 'item_classification', array['unknown_code']),

  ('formato_de_codigo',
   'Código fora do formato',
   'Quantidade de dígitos ou caractere inválido — NCM com 7 dígitos, CFOP com 5, '
   'cClassTrib com letra.',
   2, 'critical', 'both', 'item_classification', array['schema_violation']),

  ('item_sem_classificacao_reforma',
   'Item sem classificação de IBS/CBS',
   'Falta CST-IBS/CBS ou cClassTrib no cadastro. Não é erro hoje: é o trabalho que '
   'falta para o CNPJ estar pronto para a apuração de 2027.',
   3, 'medium', 'reform', 'item_classification', array['missing_reform_classification']),

  ('codigo_nao_verificado',
   'Código não verificado por falta de tabela oficial',
   'A tabela de referência não está carregada, então o código não pôde ser conferido. '
   'Ausência de erro aqui NÃO significa que está correto.',
   3, 'low', 'both', 'item_classification', array['not_verified']),

  ('item_sem_grupo_ub',
   'Nota emitida sem o grupo IBS/CBS',
   'O documento não traz o grupo UB, então o lado novo da apuração não pôde ser '
   'conferido contra a nota. Mede a prontidão da cadeia de fornecedores.',
   2, 'medium', 'reform', 'assessment', array['missing_reform_group']),

  ('regra_nao_publicada',
   'Valor devido não determinável',
   'Sem regra de creditamento publicada para a competência, débito e crédito potencial '
   'são somados mas o valor devido não é calculado. Não é erro do contribuinte.',
   null, 'medium', 'both', 'assessment', array['rule_not_published']),

  ('projecao_divergente',
   'Projeção não fecha com o event log',
   'O hash da apuração não corresponde ao replay dos eventos. Nenhum número da '
   'competência deve ser considerado válido até isto ser resolvido.',
   7, 'critical', 'both', 'output_rejected', array['verification_mismatch']),

  ('competencia_nao_confirmada',
   'Competência aberta no fechamento',
   'A competência não chegou a ser confirmada. Sem confirmação não há hash de '
   'fechamento, e portanto não há trilha de defesa para os números do mês.',
   null, 'high', 'both', 'period_state', array['open','assessed','reconciled'])

on conflict (trail_id) do update set
  name = excluded.name,
  description = excluded.description,
  layer = excluded.layer,
  default_severity = excluded.default_severity,
  tax_scope = excluded.tax_scope,
  source = excluded.source,
  matches = excluded.matches;

-- ------------------------------------------- correção de estrutura da Onda 5
--
-- `item_classifications.health_reasons` guardava apenas as MENSAGENS das
-- inconsistências. As trilhas de auditoria precisam agrupar por `reason`, e
-- casar por trecho de mensagem seria frágil: mudar o texto de um aviso quebraria
-- a agregação em silêncio.
--
-- A coluna passa a guardar a inconsistência inteira (reason, severity, field,
-- message, suggestedFix). A renomeação é segura porque a estrutura é nova e não
-- há classificação em produção; se houvesse, o caminho seria backfill.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'item_classifications'
       and column_name = 'health_reasons'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'item_classifications'
       and column_name = 'health_issues'
  ) then
    alter table public.item_classifications rename column health_reasons to health_issues;
  end if;
end $$;

alter table public.item_classifications
  add column if not exists health_issues jsonb not null default '[]'::jsonb;

comment on column public.item_classifications.health_issues is
  'Inconsistências completas (reason, severity, field, message, suggestedFix). As trilhas agrupam por reason.';

-- ----------------------------------------------------------------- Book
--
-- Os BYTES do PDF ficam guardados, não são regerados sob demanda. O Book é um
-- documento entregue a terceiro e carrega um hash no rodapé: regerar depois de
-- uma regra mudar produziria um arquivo diferente com o mesmo número de
-- identificação, e o contador perderia a capacidade de mostrar o que enviou.
create table if not exists public.books (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  cnpj             char(14) not null,
  period           char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  audience         text not null check (audience in ('accountant', 'business_owner')),
  white_label      boolean not null default false,
  include_trace    boolean not null default true,

  -- Hash da projeção no instante da geração. Vai impresso no rodapé de cada
  -- página, e é por ele que o destinatário confere a autenticidade.
  projection_hash  text not null,
  trails_summary   jsonb not null default '{}'::jsonb,
  totals_snapshot  jsonb not null default '{}'::jsonb,
  pages            integer not null default 0,

  pdf              bytea not null,
  pdf_bytes        integer not null,
  -- SHA-256 do próprio PDF: detecta troca do arquivo por quem tenha escrita na tabela.
  pdf_sha256       char(64) not null,

  event_seq        bigint not null,
  generated_by     uuid,
  generated_at     timestamptz not null default now(),

  foreign key (tenant_id, cnpj) references public.clients (tenant_id, cnpj) on delete cascade
);

create index if not exists books_scope_idx
  on public.books (tenant_id, cnpj, period, generated_at desc);

alter table public.books enable row level security;
alter table public.audit_trails disable row level security;

drop policy if exists books_select_own on public.books;
create policy books_select_own on public.books
  for select using (public.is_member_of(tenant_id));

do $$
begin
  grant select on public.audit_trails to anon, authenticated;
exception when undefined_object then
  null;
end $$;
