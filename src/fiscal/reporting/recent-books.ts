import type pg from 'pg';

export interface RecentBook {
  id: string;
  cnpj: string;
  legal_name: string | null;
  period: string;
  audience: string;
  white_label: boolean;
  pages: number;
  pdf_bytes: number;
  pdf_sha256: string;
  event_seq: number;
  generated_at: string;
}

/**
 * Os Books mais recentes da carteira inteira, sem os bytes.
 *
 * É a lista de "o que já saiu do escritório". O download continua pela rota do
 * CNPJ, que confere o escopo antes de entregar o PDF.
 */
export async function recentBooks(
  pool: pg.Pool,
  tenantId: string,
  limit: number,
): Promise<RecentBook[]> {
  const { rows } = await pool.query<{
    id: string;
    cnpj: string;
    legal_name: string | null;
    period: string;
    audience: string;
    white_label: boolean;
    pages: number;
    pdf_bytes: number;
    pdf_sha256: string;
    event_seq: string;
    generated_at: Date;
  }>(
    `select b.id, b.cnpj, c.legal_name, b.period, b.audience, b.white_label,
            b.pages, b.pdf_bytes, b.pdf_sha256, b.event_seq, b.generated_at
       from books b
       left join clients c on c.tenant_id = b.tenant_id and c.cnpj = b.cnpj
      where b.tenant_id = $1::uuid
      order by b.generated_at desc, b.id
      limit $2`,
    [tenantId, limit],
  );

  return rows.map((r) => ({
    ...r,
    cnpj: r.cnpj.trim(),
    period: r.period.trim(),
    event_seq: Number(r.event_seq),
    generated_at: new Date(r.generated_at).toISOString(),
  }));
}
