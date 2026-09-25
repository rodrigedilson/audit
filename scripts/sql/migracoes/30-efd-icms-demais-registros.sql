-- =============================================================================
-- audit — passo 30 de 40: efd-icms-demais-registros
--
-- EFD ICMS/IPI: a conciliação passa a somar energia, transporte, comunicação
-- e varejo (C590, D190, D590, C320 a C890) contra o E110, e cada linha diz
-- qual analítico soma. Atualiza a descrição da feature sped_completo.
--
-- ARQUIVO GERADO por `npm run sql:bundle`. Origem: supabase/migrations/20260926120000_efd_icms_demais_registros.sql
-- Não edite aqui: altere a migration de origem.
--
-- Execute os passos NA ORDEM: cada um depende das tabelas do anterior.
-- Pode rodar de novo sem duplicar nada.
-- =============================================================================

-- =============================================================================
-- EFD ICMS/IPI: os registros que lançam ICMS fora do C100
--
-- A conciliação comparava só os C190 com o E110 e, na presença de qualquer
-- registro dos blocos C5 a C9 ou D, deixava a soma como "não verificado". O
-- prefixo casava com C990, D001 e D990, que existem em todo arquivo: a
-- conferência principal nunca rodava.
--
-- O leitor passa a somar C590, D190 e D590 (energia, transporte, comunicação),
-- com o sentido e a situação do documento pai, e os analíticos só de saída
-- (C320, C390, C490, C690, C790, C890). Cada linha diz qual analítico soma: é
-- assim que o arquivo importado antes desta migration, que não tem linha
-- desses registros, continua não verificado em vez de acusar diferença.
-- =============================================================================

alter table public.efd_icms_documents
  add column if not exists record text not null default 'C190',
  -- VL_ICMS dos analíticos com CFOP 1605/5605, que o guia soma no lado oposto.
  add column if not exists transfer_icms_cents bigint not null default 0;

comment on column public.efd_icms_documents.record is
  'Analítico somado pela linha: C190 (documento C100), C590, D190, D590, ou o agregado de C320/C390/C490/C690/C790/C890.';

update public.plan_features
   set description = 'EFD ICMS/IPI (leiautes 019 e 020) e EFD-Contribuições conciliadas com os documentos '
                  || 'recebidos. O leiaute 021 entra quando o leiaute oficial for publicado em formato legível.',
       updated_at = now()
 where key = 'sped_completo';
