import { readFileSync } from 'node:fs';

/**
 * Carrega um arquivo `.env` para `process.env`.
 *
 * Escrito à mão em vez de usar uma dependência porque o comportamento importa e
 * precisa ser testável: um parser que erra o unquoting de um valor com `#` ou
 * `=` dentro produz falha de autenticação sem explicação, e o operador procura
 * o defeito no lugar errado.
 *
 * **O ambiente real tem precedência sobre o arquivo.** Um `.env` esquecido na
 * máquina não pode sobrepor a variável que a plataforma injetou em produção —
 * seria a origem exata de "funciona na minha máquina".
 */

export interface LoadResult {
  /** Chaves que este carregamento definiu. */
  loaded: string[];
  /** Chaves presentes no arquivo mas já definidas no ambiente. */
  skipped: string[];
  /** `false` quando o arquivo não existe, o que é situação normal. */
  found: boolean;
}

export function loadDotEnv(path = '.env', target: NodeJS.ProcessEnv = process.env): LoadResult {
  let conteudo: string;
  try {
    conteudo = readFileSync(path, 'utf8');
  } catch {
    // Ausência de `.env` é normal: em produção as variáveis vêm da plataforma.
    return { loaded: [], skipped: [], found: false };
  }

  const loaded: string[] = [];
  const skipped: string[] = [];

  for (const [chave, valor] of parseDotEnv(conteudo)) {
    if (target[chave] !== undefined) {
      skipped.push(chave);
      continue;
    }
    target[chave] = valor;
    loaded.push(chave);
  }

  return { loaded, skipped, found: true };
}

/** Exportado para teste: a análise é a parte que pode errar em silêncio. */
export function parseDotEnv(conteudo: string): [string, string][] {
  const pares: [string, string][] = [];

  for (const linha of conteudo.split(/\r?\n/)) {
    const par = parseLinha(linha);
    if (par) {
      pares.push(par);
    }
  }

  return pares;
}

const ATRIBUICAO = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseLinha(linha: string): [string, string] | null {
  const limpa = linha.trim();

  if (limpa.length === 0 || limpa.startsWith('#')) {
    return null;
  }

  const encontrado = ATRIBUICAO.exec(limpa);
  if (!encontrado) {
    return null;
  }

  const [, chave, bruto] = encontrado;
  return [chave!, desempacotar(bruto!)];
}

/**
 * Remove aspas e comentário de fim de linha.
 *
 * A ordem importa: dentro de aspas, `#` é conteúdo. Cortar o comentário antes de
 * olhar as aspas mutilaria uma senha que contenha `#` — e senha com caractere
 * especial é justamente o caso comum.
 */
function desempacotar(bruto: string): string {
  const valor = bruto.trim();

  if (valor.startsWith('"') && valor.endsWith('"') && valor.length >= 2) {
    // Só aspas duplas interpretam escapes, como no shell.
    return valor
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  if (valor.startsWith("'") && valor.endsWith("'") && valor.length >= 2) {
    return valor.slice(1, -1);
  }

  // Sem aspas: ` #` inicia comentário. Exige o espaço para não cortar um valor
  // que legitimamente contenha `#`, como uma senha `abc#123`.
  const comentario = valor.search(/\s#/);
  return (comentario === -1 ? valor : valor.slice(0, comentario)).trim();
}
