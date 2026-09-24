/**
 * Extrai as posições de campo do Guia Prático da EFD ICMS/IPI.
 *
 * O parser de SPED lê campo **por posição**, e o próprio comentário do parser de
 * EFD-Contribuições diz por que isso exige cuidado: posição errada produz valor
 * de dinheiro errado, não erro. Escrever as posições de memória é o caminho mais
 * curto para um dossiê com números plausíveis e falsos.
 *
 * Este script lê o Guia Prático oficial em PDF e imprime a tabela de campos dos
 * registros pedidos, na forma em que o parser precisa. A fonte é a Receita:
 *
 * https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos
 *
 * Depende de `pdftotext` (poppler-utils), que já está no ambiente de
 * desenvolvimento. Não roda em produção e não toca no banco.
 *
 * ```
 * npx tsx scripts/extrair-layout-efd.ts guia.pdf C170 C190 E110
 * ```
 */
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executar = promisify(execFile);

interface Campo {
  posicao: number;
  nome: string;
  descricao: string;
}

/**
 * Uma linha de campo na tabela do guia começa com o número de dois dígitos e o
 * nome em maiúsculas. O resto da linha é descrição e metadados de tipo e
 * tamanho, que o parser não usa.
 */
const LINHA_DE_CAMPO = /^\s*(\d{2})\s+([A-Z][A-Z0-9_]{1,})\s+(.*)$/;

function camposDoRegistro(texto: string, registro: string): Campo[] {
  const inicio = texto.indexOf(`REGISTRO ${registro}:`);
  if (inicio === -1) {
    return [];
  }

  const campos: Campo[] = [];
  let esperado = 1;

  // A tabela de campos pode ficar páginas depois do cabeçalho do registro — no
  // C100 vêm antes cinco exceções de preenchimento. A janela é larga o bastante
  // para alcançá-la e estreita o bastante para não varrer o guia inteiro.
  for (const linha of texto.slice(inicio, inicio + 40_000).split('\n')) {
    const m = LINHA_DE_CAMPO.exec(linha);
    if (m === null) {
      continue;
    }

    const posicao = Number(m[1]);

    // A numeração é sequencial a partir de 01. Qualquer salto significa que a
    // varredura saiu da tabela e entrou noutro trecho do guia — parar ali é
    // melhor do que colecionar linhas de outro registro como se fossem deste.
    if (posicao !== esperado) {
      if (esperado > 1) {
        break;
      }
      continue;
    }

    campos.push({
      posicao,
      nome: m[2]!,
      descricao: m[3]!.replace(/\s{2,}/g, ' ').trim(),
    });
    esperado += 1;
  }

  // Se o primeiro campo não anuncia este registro, a varredura passou da tabela
  // dele e pegou a de outro. Devolver vazio é o único resultado honesto: posição
  // do layout errado é exatamente o erro que este script existe para evitar.
  if (campos[0] !== undefined && !campos[0].descricao.includes(registro)) {
    return [];
  }

  return campos;
}

async function main(): Promise<void> {
  const [pdf, ...registros] = process.argv.slice(2);

  if (pdf === undefined || registros.length === 0) {
    console.error('Uso: npx tsx scripts/extrair-layout-efd.ts <guia.pdf> C170 C190 …');
    process.exitCode = 1;
    return;
  }

  const saida = join(tmpdir(), `guia-efd-${process.pid}.txt`);
  try {
    await executar('pdftotext', ['-layout', pdf, saida]);
  } catch {
    console.error(
      'Não foi possível rodar `pdftotext`. Instale poppler-utils, ou converta o\n' +
        'guia para texto por outro meio e ajuste a chamada.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const texto = await readFile(saida, 'utf8');

    for (const registro of registros) {
      const campos = camposDoRegistro(texto, registro);

      if (campos.length === 0) {
        console.error(`\n${registro}: não encontrado no guia. Confira a sigla.`);
        process.exitCode = 1;
        continue;
      }

      console.log(`\n=== ${registro} — ${campos.length} campos`);
      for (const campo of campos) {
        // `campos[N]` no parser corresponde ao campo N do layout, porque a linha
        // começa com pipe e o split produz vazio na posição 0.
        console.log(
          `  campos[${String(campo.posicao).padStart(2, '0')}] ${campo.nome.padEnd(16)} ` +
            `${campo.descricao.slice(0, 60)}`,
        );
      }
    }
  } finally {
    await unlink(saida).catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
