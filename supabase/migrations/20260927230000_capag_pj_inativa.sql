-- =============================================================================
-- CAPAG presumida: grupo da pessoa jurídica inativa
--
-- A página da PGFN publica cinco fórmulas. A quinta é a da pessoa jurídica
-- inativa (nula, baixada, suspensa ou inapta), com coeficientes e uma variável
-- (V11) próprios. Sem o grupo, o buscador não tinha onde guardá-la, e o
-- demonstrativo de um CNPJ inativo ficava sem grupo.
-- =============================================================================

alter table public.capag_reference_formulas
  drop constraint if exists capag_reference_formulas_capag_group_check;

alter table public.capag_reference_formulas
  add constraint capag_reference_formulas_capag_group_check
  check (capag_group in ('pessoa_fisica', 'pj_nao_simples', 'pj_simples', 'mei', 'pj_inativa'));

alter table public.capag_statements
  drop constraint if exists capag_statements_capag_group_check;

alter table public.capag_statements
  add constraint capag_statements_capag_group_check
  check (capag_group is null or capag_group in ('pessoa_fisica', 'pj_nao_simples', 'pj_simples', 'mei', 'pj_inativa'));
