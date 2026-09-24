import type { FastifyRequest } from 'fastify';
import { ValidationError } from '../esaa/shared/types/esaa-errors.js';
import type { UploadedFile } from '../fiscal/ingestion/ingestion.service.js';

/**
 * Leitura dos XMLs de um multipart.
 *
 * Saiu de `ingestion.routes.ts` para poder servir também a rota pública de
 * diagnóstico, que precisa dos mesmos arquivos com limites muito menores — ela
 * é anônima e o parsing é CPU-bound.
 */

export interface XmlUploadLimits {
  maxFiles: number;
  /**
   * Teto **acumulado** do lote. O limite por arquivo do `@fastify/multipart` não
   * basta: `fileSize × maxFiles` é o pior caso real, e numa rota sem
   * autenticação esse pior caso é o caso.
   */
  maxTotalBytes: number;
  /** Campos de texto aceitos. Os demais são ignorados em silêncio. */
  allowedFields?: readonly string[];
}

export interface XmlUpload {
  files: UploadedFile[];
  fields: Record<string, string>;
}

/**
 * Rejeita o lote inteiro só por problema de forma (nenhum arquivo, arquivos
 * demais, bytes demais); conteúdo inválido é decidido por arquivo, mais adiante.
 */
export async function readXmlUpload(
  request: FastifyRequest,
  limits: XmlUploadLimits,
): Promise<XmlUpload> {
  const files: UploadedFile[] = [];
  const fields: Record<string, string> = {};
  let totalBytes = 0;

  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      if (limits.allowedFields?.includes(part.fieldname)) {
        fields[part.fieldname] = String(part.value ?? '');
      }
      continue;
    }

    if (files.length >= limits.maxFiles) {
      throw new ValidationError(
        1,
        'schema_violation',
        `Máximo de ${limits.maxFiles} arquivos por requisição.`,
      );
    }

    const buffer = await part.toBuffer();
    totalBytes += buffer.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      const mb = Math.round(limits.maxTotalBytes / (1024 * 1024));
      throw new ValidationError(
        1,
        'schema_violation',
        `O lote excede ${mb} MB no total.`,
      );
    }

    files.push({
      filename: part.filename ?? `arquivo-${files.length + 1}.xml`,
      content: buffer.toString('utf8'),
    });
  }

  if (files.length === 0) {
    throw new ValidationError(1, 'schema_violation', 'Nenhum arquivo XML enviado.');
  }

  return { files, fields };
}
