/**
 * Leitura da Tabela 4.3.10 da EFD-Contribuições — produtos sujeitos a
 * alíquotas diferenciadas: incidência monofásica e por pauta (CST 02 e 04).
 *
 * A RFB publica a tabela só em `.doc` (Word 97), e a coluna de NCM é **texto
 * livre**: posições (`30.01`), itens (`3002.10.1`), faixas (`33.03 a 33.07`),
 * exceções (`exceto no código 3003.90.56`) e ex-tarifários (`2208.90.00 Ex 01`).
 * Este módulo não adivinha: o que ele não reconhece volta como não resolvido, e
 * quem carrega decide o que fazer — nunca marca um NCM por aproximação.
 *
 * Tudo aqui é puro, para ser testado com o texto real das células sem rede nem
 * banco. O download e a gravação ficam em `scripts/carregar-ncm-monofasico.ts`.
 */

/** Um período de vigência de um código da tabela. */
export interface Periodo {
  pis: number;
  cofins: number;
  /** ISO `YYYY-MM-DD`. Mês/ano sem dia vira o dia 1. */
  inicio: string;
  /** ISO `YYYY-MM-DD`, ou `null` quando o período está em aberto. Mês/ano vira o último dia. */
  termino: string | null;
}

export interface Registro {
  codigo: string;
  descricao: string;
  /** Células de NCM, na ordem, antes da primeira alíquota. */
  ncm: string[];
  periodos: Periodo[];
}

/** Um NCM (ou prefixo) incluído, com a ressalva de ex-tarifário quando houver. */
export interface Inclusao {
  /** Dígitos, de 2 a 8. Menos de 8 é posição ou item: cobre todos os NCMs abaixo. */
  prefixo: string;
  /** Só estes ex-tarifários do código estão na tabela. */
  somenteEx?: string[];
  /** O código está na tabela, menos estes ex-tarifários. */
  excetoEx?: string[];
}

export interface NcmInterpretado {
  inclusoes: Inclusao[];
  /** NCMs de 8 dígitos (ou prefixos) excluídos de uma posição incluída. */
  exclusoes: string[];
  /**
   * Texto que remete para fora da tabela ("Anexos I e II da Lei nº 10.485/02")
   * ou que não trouxe código nenhum. Não é erro: é dado que a tabela não tem.
   */
  remissao: string | null;
}

export type GrupoMonofasico =
  | 'combustiveis'
  | 'farmacos'
  | 'perfumaria'
  | 'veiculos'
  | 'autopecas'
  | 'pneus'
  | 'bebidas_frias';

/** Cabeçalho que prova que o arquivo é a tabela certa. */
const TITULO = 'Tabela 4.3.10';

const CODIGO = /^\d{3}$/;
/**
 * Alíquota em percentual. A tabela usa vírgula, com um ou outro `7.69` de
 * ponto — e o ponto só vale com um dígito inteiro: `22.03` é a posição da
 * cerveja, não 22,03%, e tratá-la como alíquota tirava a cerveja da tabela.
 */
const ALIQUOTA = /^(?:\d+,\d+|\d\.\d{1,2})$/;
const DATA = /^(?:\d{2}\/)?\d{2}\/\d{4}$/;

/**
 * Extrai as células de tabela do `.doc`.
 *
 * O texto de um `.doc` com todos os caracteres em Windows-1252 fica no fluxo
 * `WordDocument` em 8 bits, e cada célula de tabela termina com o caractere
 * `\x07`. Não é um leitor de Word: é o suficiente para esta tabela, e falha
 * alto se o arquivo não tiver o título esperado — um formato novo tem de parar
 * a carga, e não carregar lixo.
 */
export function extrairCelulas(doc: Uint8Array): string[] {
  const texto = new TextDecoder('windows-1252').decode(doc);
  const inicio = texto.indexOf(TITULO);
  if (inicio === -1) {
    throw new Error(
      `O arquivo não contém "${TITULO}" em Windows-1252. O formato da fonte mudou, ` +
        'ou o arquivo não é a tabela.',
    );
  }

  return texto
    .slice(inicio)
    .split('\x07')
    .map((celula) =>
      celula
        // Controles do Word (marcas de campo, quebras especiais) viram espaço.
        .replace(/[\x00-\x06\x08\x0b\x0c\x0e-\x1f]/g, ' ')
        .replace(/\r/g, '\n')
        .trim(),
    )
    .filter((celula) => celula !== '');
}

/**
 * Agrupa as células em registros.
 *
 * Não depende do fim de linha da tabela, que o `.doc` não marca de forma
 * distinguível: um registro começa numa célula de exatamente três dígitos, e
 * as células seguintes se classificam pelo formato — NCM até a primeira
 * alíquota, depois grupos `PIS, Cofins, início, [término]`.
 */
export function lerRegistros(celulas: readonly string[]): Registro[] {
  const registros: Registro[] = [];
  let atual: { codigo: string; resto: string[] } | null = null;

  const fechar = (): void => {
    if (atual === null || atual.resto.length === 0) {
      return;
    }
    const [descricao = '', ...resto] = atual.resto;
    const primeiraAliquota = resto.findIndex((c) => ALIQUOTA.test(c));
    const ncm = primeiraAliquota === -1 ? resto : resto.slice(0, primeiraAliquota);
    const periodos = primeiraAliquota === -1 ? [] : lerPeriodos(resto.slice(primeiraAliquota));
    registros.push({ codigo: atual.codigo, descricao, ncm, periodos });
  };

  for (const celula of celulas) {
    if (CODIGO.test(celula)) {
      fechar();
      atual = { codigo: celula, resto: [] };
    } else if (atual !== null) {
      atual.resto.push(celula);
    }
  }
  fechar();

  return registros;
}

function lerPeriodos(celulas: readonly string[]): Periodo[] {
  const periodos: Periodo[] = [];
  let i = 0;

  while (i + 2 < celulas.length) {
    const pis = celulas[i]!;
    const cofins = celulas[i + 1]!;
    const inicio = celulas[i + 2]!;
    if (!ALIQUOTA.test(pis) || !ALIQUOTA.test(cofins) || !DATA.test(inicio)) {
      // Fim dos períodos: o que vem depois (notas de versão, por exemplo) não
      // é deste registro.
      break;
    }
    const talvezTermino = celulas[i + 3];
    const temTermino = talvezTermino !== undefined && DATA.test(talvezTermino);

    periodos.push({
      pis: numero(pis),
      cofins: numero(cofins),
      inicio: dataIso(inicio, 'inicio'),
      termino: temTermino ? dataIso(talvezTermino, 'fim') : null,
    });
    i += temTermino ? 4 : 3;
  }

  return periodos;
}

function numero(valor: string): number {
  return Number(valor.replace(',', '.'));
}

/** `MM/AAAA` ou `DD/MM/AAAA`. Mês/ano é o dia 1 no início e o último dia no fim. */
export function dataIso(valor: string, lado: 'inicio' | 'fim'): string {
  const partes = valor.split('/').map(Number);
  if (partes.length === 3) {
    const [dia, mes, ano] = partes as [number, number, number];
    return iso(ano, mes, dia);
  }
  const [mes, ano] = partes as [number, number];
  if (lado === 'inicio') {
    return iso(ano, mes, 1);
  }
  // Dia 0 do mês seguinte é o último do mês.
  return iso(ano, mes, new Date(Date.UTC(ano, mes, 0)).getUTCDate());
}

function iso(ano: number, mes: number, dia: number): string {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** O período que vale em `hoje`, se houver. */
export function periodoVigente(registro: Registro, hoje: string): Periodo | undefined {
  return registro.periodos.find(
    (p) => p.inicio <= hoje && (p.termino === null || p.termino >= hoje),
  );
}

/**
 * A qual regime monofásico o código da tabela pertence.
 *
 * `null` para o que está na tabela e **não** é monofásico: as linhas de revenda
 * (`001`–`004`, `199`, `299`, `399`, `499`), que descrevem a operação e não o
 * produto, e as alíquotas reduzidas da nafta e dos insumos petroquímicos
 * (`150`–`153`), que são diferenciadas sem ser concentradas no produtor.
 */
export function grupoMonofasico(codigo: string): GrupoMonofasico | null {
  const n = Number(codigo);
  if (n >= 101 && n <= 117) return 'combustiveis';
  if (n === 201) return 'farmacos';
  if (n === 202) return 'perfumaria';
  if (n === 301) return 'veiculos';
  if (n === 302 || n === 303) return 'autopecas';
  if (n === 304) return 'pneus';
  if (n >= 401 && n <= 498) return 'bebidas_frias';
  return null;
}

/**
 * Código NCM em qualquer das grafias da tabela: `30.01`, `3002.10.1`,
 * `2710.12.59`, `84.32.80.00`, `8433.5`. **No mínimo quatro dígitos**: a tabela
 * cita posições, não capítulos, e aceitar dois dígitos faria o `01` de `Ex 01`
 * virar o capítulo 01 inteiro. Não pode estar colado a outro dígito — sem isso,
 * `Lei nº 13.097` viraria a posição `13.09`.
 */
const NCM_FONTE = String.raw`(?<![\d.])\d{2}\.?\d{2}(?:\.\d{1,2}){0,2}(?!\.?\d)`;

/** Lista de ex-tarifários logo após um código: `Ex 01`, `Ex 01 e Ex 02`, `Ex 01, 02`. */
const EX_FONTE = String.raw`Ex\s*\d{2}(?![\d.])(?:\s*(?:,|e)\s*(?:Ex\s*)?\d{2}(?![\d.]))*`;

function digitos(codigo: string): string {
  return codigo.replace(/\D/g, '');
}

function numerosDeEx(trecho: string): string[] {
  return [...new Set(trecho.replace(/Ex/gi, ' ').match(/\d{2}/g) ?? [])];
}

/**
 * Interpreta o texto livre da coluna NCM.
 *
 * Três construções mudam o sentido de um código e são lidas antes da leitura
 * simples, que as removem do texto:
 *
 * - `exceto os Ex 01 e Ex 02 do código 22.01.10.00` e `3401.11.90 (exceto
 *   3401.11.90 Ex 01)`: o código entra, com a ressalva dos ex-tarifários;
 * - `(exceto no código 3003.90.56)`: o código sai da posição que o contém;
 * - `2208.90.00 Ex 01`: só aquele ex-tarifário está na tabela.
 *
 * Faixa `33.03 a 33.07` vira as posições intermediárias.
 */
export function interpretarNcm(celulas: readonly string[]): NcmInterpretado {
  let texto = celulas.join(' ').replace(/\s+/g, ' ').trim();
  const excetoEx = new Map<string, string[]>();
  const exclusoes: string[] = [];

  const exDoCodigo = new RegExp(
    String.raw`exceto\s+(?:os\s+)?(${EX_FONTE})\s+do\s+c[óo]digo\s+(${NCM_FONTE})`,
    'gi',
  );
  texto = texto.replace(exDoCodigo, (_m, ex: string, codigo: string) => {
    excetoEx.set(digitos(codigo), numerosDeEx(ex));
    return ' ';
  });

  const codigoComEx = new RegExp(String.raw`(${NCM_FONTE})(?:\s*(${EX_FONTE}))?`, 'g');
  texto = texto.replace(/\(\s*exceto\s+([^)]*)\)/gi, (_m, dentro: string) => {
    for (const m of dentro.matchAll(codigoComEx)) {
      const codigo = digitos(m[1]!);
      if (m[2] === undefined) {
        exclusoes.push(codigo);
      } else {
        excetoEx.set(codigo, numerosDeEx(m[2]));
      }
    }
    return ' ';
  });

  texto = texto.replace(
    new RegExp(String.raw`(${NCM_FONTE})\s+a\s+(${NCM_FONTE})`, 'g'),
    (_m, de: string, ate: string) => {
      const a = digitos(de);
      const b = digitos(ate);
      if (a.length !== b.length) {
        return ` ${de} ${ate} `;
      }
      const lista: string[] = [];
      for (let n = Number(a); n <= Number(b); n += 1) {
        lista.push(String(n).padStart(a.length, '0'));
      }
      return ` ${lista.join(', ')} `;
    },
  );

  /** Ex-tarifários por código; `null` quando o código apareceu inteiro. */
  const vistos = new Map<string, Set<string> | null>();
  for (const m of texto.matchAll(codigoComEx)) {
    const codigo = digitos(m[1]!);
    if (m[2] === undefined) {
      // O mesmo código também sem "Ex" (`3826.00.00` e `3826.00.00 Ex 01` no
      // biodiesel) é o código inteiro.
      vistos.set(codigo, null);
    } else if (vistos.get(codigo) !== null) {
      const atual = vistos.get(codigo) ?? new Set<string>();
      for (const ex of numerosDeEx(m[2])) atual.add(ex);
      vistos.set(codigo, atual);
    }
  }
  for (const codigo of excetoEx.keys()) {
    if (!vistos.has(codigo)) vistos.set(codigo, null);
  }

  const inclusoes: Inclusao[] = [...vistos].map(([prefixo, somente]) => {
    const inclusao: Inclusao = { prefixo };
    if (somente !== null) inclusao.somenteEx = [...somente];
    const exceto = excetoEx.get(prefixo);
    if (exceto !== undefined) inclusao.excetoEx = exceto;
    return inclusao;
  });

  return {
    inclusoes,
    exclusoes,
    remissao: inclusoes.length === 0 ? celulas.join(' ').replace(/\s+/g, ' ').trim() || null : null,
  };
}

/**
 * Expande as inclusões contra a tabela oficial de NCM.
 *
 * Prefixo vira todos os NCMs de 8 dígitos que começam por ele. Um prefixo que
 * não casa com nenhum NCM oficial é devolvido em `semCorrespondencia`: ou a
 * nomenclatura mudou, ou a tabela da RFB citou código que não existe — em
 * qualquer caso, não se inventa o NCM.
 */
export function expandir(
  interpretado: NcmInterpretado,
  ncmsOficiais: readonly string[],
): { ncms: Map<string, string | null>; semCorrespondencia: string[] } {
  const ncms = new Map<string, string | null>();
  const semCorrespondencia: string[] = [];
  const excluidos = (ncm: string): boolean =>
    interpretado.exclusoes.some((e) => ncm.startsWith(e));

  for (const inclusao of interpretado.inclusoes) {
    const casados = ncmsOficiais.filter((n) => n.startsWith(inclusao.prefixo) && !excluidos(n));
    if (casados.length === 0) {
      semCorrespondencia.push(inclusao.prefixo);
      continue;
    }
    const ressalva =
      inclusao.somenteEx !== undefined
        ? `somente Ex ${inclusao.somenteEx.join(', ')}`
        : inclusao.excetoEx !== undefined
          ? `exceto Ex ${inclusao.excetoEx.join(', ')}`
          : null;
    for (const ncm of casados) {
      ncms.set(ncm, ressalva);
    }
  }

  return { ncms, semCorrespondencia };
}
