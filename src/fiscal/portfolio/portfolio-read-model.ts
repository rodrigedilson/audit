import type { Pool } from 'pg';
import type { FiscalProjection } from '../shared/fiscal-projection.types.js';

/**
 * Sincroniza as tabelas `clients` e `periods` a partir da projeção.
 *
 * Essas tabelas são **read model**, não fonte da verdade: existem para a carteira
 * carregar rápido e para o RLS ter onde se ancorar. A verdade é o event log, e
 * qualquer uma delas pode ser reconstruída por replay.
 *
 * Por isso o upsert é idempotente e roda **depois** do append do evento: se
 * falhar, o read model fica velho até a próxima escrita ou até um rebuild — o
 * que é recuperável. O inverso (gravar a tabela antes do evento) criaria estado
 * que o log não explica, e é isso que o produto promete não fazer.
 */
export async function syncPortfolioReadModel(
  pool: Pool,
  projection: FiscalProjection,
): Promise<void> {
  const { tenant_id: tenantId, cnpj, client } = projection;

  if (client) {
    await pool.query(
      `insert into clients (
         tenant_id, cnpj, legal_name, trade_name, regime, uf,
         municipality_ibge, cnae_primary, status
       ) values ($1::uuid, $2::char(14), $3, $4, $5::regime, $6, $7, $8, $9)
       on conflict (tenant_id, cnpj) do update set
         legal_name = excluded.legal_name,
         trade_name = excluded.trade_name,
         regime = excluded.regime,
         uf = excluded.uf,
         municipality_ibge = excluded.municipality_ibge,
         cnae_primary = excluded.cnae_primary,
         status = excluded.status`,
      [
        tenantId,
        cnpj,
        client.legal_name,
        client.trade_name ?? null,
        client.regime,
        client.uf ?? null,
        client.municipality_ibge ?? null,
        client.cnae_primary ?? null,
        client.status,
      ],
    );
  }

  for (const period of Object.values(projection.periods)) {
    await pool.query(
      `insert into periods (
         tenant_id, cnpj, period, state, projection_hash, confirmed_at, confirmed_by
       ) values ($1::uuid, $2::char(14), $3::char(7), $4::period_state, $5, $6, $7::uuid)
       on conflict (tenant_id, cnpj, period) do update set
         state = excluded.state,
         projection_hash = excluded.projection_hash,
         confirmed_at = excluded.confirmed_at,
         confirmed_by = excluded.confirmed_by`,
      [
        tenantId,
        cnpj,
        period.period,
        period.state,
        period.projection_hash ?? null,
        period.confirmed_at ?? null,
        period.confirmed_by ?? null,
      ],
    );
  }
}
