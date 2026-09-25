import { createHash } from 'node:crypto';
import { LegacyArchiveError, type DownloadedObject, type StoredObjectRef } from './legacy-archive.js';

/**
 * Baixa os objetos dos buckets do Supabase Storage, pela API, com a chave de
 * serviço. O conteúdo dos arquivos não está no Postgres — só o índice em
 * `storage.objects` —, então a cópia do banco sozinha perderia os originais.
 *
 * Objeto que não baixa é falha da cópia inteira, e não item pulado.
 */
export type FetchObject = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export async function baixarObjetos(
  objetos: readonly StoredObjectRef[],
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchObject: FetchObject = fetch,
): Promise<DownloadedObject[]> {
  const base = supabaseUrl.replace(/\/$/, '');
  const baixados: DownloadedObject[] = [];
  for (const o of objetos) {
    const caminho = o.name.split('/').map(encodeURIComponent).join('/');
    const url = `${base}/storage/v1/object/authenticated/${encodeURIComponent(o.bucket)}/${caminho}`;
    const resposta = await fetchObject(url, {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    });
    if (!resposta.ok) {
      throw new LegacyArchiveError(`${o.bucket}/${o.name}: o storage respondeu ${resposta.status}. Nada foi gravado.`);
    }
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    const esperado = (o.metadata as { size?: unknown } | null)?.size;
    if (typeof esperado === 'number' && esperado !== bytes.length) {
      throw new LegacyArchiveError(
        `${o.bucket}/${o.name}: baixou ${bytes.length} byte(s), o índice do storage diz ${esperado}. Nada foi gravado.`,
      );
    }
    baixados.push({
      ...o,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return baixados;
}
