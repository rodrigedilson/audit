import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { readXmlUpload } from '../../src/api/multipart.js';
import { ValidationError } from '../../src/esaa/shared/types/esaa-errors.js';

interface ParteFalsa {
  type: 'file' | 'field';
  fieldname: string;
  filename?: string;
  value?: string;
  conteudo?: string;
}

/** Requisição mínima: só o que `readXmlUpload` consome. */
function requisicao(partes: ParteFalsa[]): FastifyRequest {
  return {
    async *parts() {
      for (const parte of partes) {
        yield parte.type === 'file'
          ? {
              type: 'file' as const,
              fieldname: parte.fieldname,
              filename: parte.filename,
              toBuffer: async () => Buffer.from(parte.conteudo ?? '', 'utf8'),
            }
          : { type: 'field' as const, fieldname: parte.fieldname, value: parte.value };
      }
    },
  } as unknown as FastifyRequest;
}

const arquivo = (nome: string, conteudo = '<xml/>'): ParteFalsa => ({
  type: 'file',
  fieldname: 'files',
  filename: nome,
  conteudo,
});

describe('readXmlUpload', () => {
  const limites = { maxFiles: 3, maxTotalBytes: 1000 };

  it('lê os arquivos na ordem em que chegaram', async () => {
    const upload = await readXmlUpload(requisicao([arquivo('a.xml'), arquivo('b.xml')]), limites);

    expect(upload.files.map((f) => f.filename)).toEqual(['a.xml', 'b.xml']);
    expect(upload.files[0]!.content).toBe('<xml/>');
  });

  it('nomeia arquivo sem nome, para a rejeição ter a que se referir', async () => {
    const upload = await readXmlUpload(
      requisicao([{ type: 'file', fieldname: 'files', conteudo: '<xml/>' }]),
      limites,
    );

    expect(upload.files[0]!.filename).toBe('arquivo-1.xml');
  });

  it('recusa lote vazio', async () => {
    await expect(readXmlUpload(requisicao([]), limites)).rejects.toThrow(ValidationError);
  });

  it('recusa acima do teto de arquivos', async () => {
    const partes = [arquivo('1.xml'), arquivo('2.xml'), arquivo('3.xml'), arquivo('4.xml')];

    await expect(readXmlUpload(requisicao(partes), limites)).rejects.toThrow(/3 arquivos/);
  });

  /**
   * O limite por arquivo do multipart não basta: `fileSize × maxFiles` é o pior
   * caso real, e numa rota sem autenticação o pior caso é o caso.
   */
  it('recusa acima do teto acumulado de bytes, mesmo dentro do limite de arquivos', async () => {
    const grande = 'x'.repeat(600);
    const partes = [arquivo('1.xml', grande), arquivo('2.xml', grande)];

    await expect(readXmlUpload(requisicao(partes), { maxFiles: 10, maxTotalBytes: 1000 })).rejects.toThrow(
      /MB no total/,
    );
  });

  it('guarda só os campos declarados, ignorando o resto', async () => {
    const partes: ParteFalsa[] = [
      { type: 'field', fieldname: 'email', value: 'a@b.com' },
      { type: 'field', fieldname: 'intruso', value: 'nao deve entrar' },
      arquivo('a.xml'),
    ];

    const upload = await readXmlUpload(requisicao(partes), {
      ...limites,
      allowedFields: ['email'],
    });

    expect(upload.fields).toEqual({ email: 'a@b.com' });
  });

  it('sem campos declarados, nenhum campo é lido', async () => {
    const partes: ParteFalsa[] = [
      { type: 'field', fieldname: 'email', value: 'a@b.com' },
      arquivo('a.xml'),
    ];

    const upload = await readXmlUpload(requisicao(partes), limites);

    expect(upload.fields).toEqual({});
  });
});
