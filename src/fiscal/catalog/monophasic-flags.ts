import {
  expandir,
  grupoMonofasico,
  interpretarNcm,
  periodoVigente,
  type Inclusao,
  type NcmInterpretado,
  type Registro,
} from './monophasic-table.js';

/**
 * Montagem de `ncm_flags` a partir da Tabela 4.3.10 e, para as autopeças, dos
 * Anexos I e II da Lei nº 10.485/2002.
 *
 * As autopeças (códigos 302 e 303 da tabela) não trazem NCM: a célula diz
 * "Anexos I e II da Lei nº 10.485/02". A lista está na lei, e é dela que sai —
 * sem ela, as autopeças ficariam fora da marcação, e o monofásico mais comum
 * no varejo automotivo não apareceria.
 */

/** Um item do Anexo II: o produto só é monofásico com o destino que o item diz. */
export interface ItemCondicionado {
  item: number;
  produto: Inclusao;
  texto: string;
}

export interface AnexosLei10485 {
  /** Anexo I: autopeças sem condição de destino. */
  anexoI: NcmInterpretado;
  /** Anexo II: autopeças condicionadas ao destino (máquina ou veículo). */
  anexoII: ItemCondicionado[];
}

/** Uma linha de `ncm_flags` pronta para gravar. */
export interface LinhaFlag {
  ncm: string;
  validFrom: string;
  note: string;
}

export interface Montagem {
  linhas: LinhaFlag[];
  /** Prefixos citados pela fonte sem NCM oficial correspondente. */
  semCorrespondencia: { origem: string; prefixo: string }[];
  /** Registros vigentes cuja célula remete a um texto que esta carga não lê. */
  remissoesNaoLidas: { codigo: string; texto: string }[];
}

/** Converte o HTML do Planalto em texto corrido. */
export function textoDoHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lê os Anexos I e II da Lei nº 10.485/2002 no texto compilado do Planalto.
 *
 * As notas de redação — "(Redação dada pelo Decreto nº 4.542, de 2002 …)" e
 * "(Vide art. 3º §1)" — saem antes da leitura: o ano `2002` passaria por
 * posição NCM 20.02, que é tomate.
 */
export function lerAnexosLei10485(texto: string): AnexosLei10485 {
  const i = texto.search(/ANEXO I\b/);
  const ii = texto.search(/ANEXO II\b/);
  if (i === -1 || ii === -1 || ii < i) {
    throw new Error('Os Anexos I e II não foram encontrados no texto da Lei nº 10.485/2002.');
  }

  const semNotas = (trecho: string): string =>
    trecho.replace(/\((?:Reda[çc][ãa]o|Vide|Inclu[íi]d|Revogad)[^)]*\)/gi, ' ');

  const anexoI = interpretarNcm([semNotas(texto.slice(i + 'ANEXO I'.length, ii))]);

  // O anexo termina no asterisco que abre as notas de rodapé da página.
  const restoII = semNotas(texto.slice(ii + 'ANEXO II'.length));
  const fimII = restoII.indexOf(' * ');
  const corpoII = fimII === -1 ? restoII : restoII.slice(0, fimII);
  const anexoII: ItemCondicionado[] = [];
  for (const m of corpoII.matchAll(/(?:^|\s)(\d{1,2})\.\s+(.+?)(?=\s\d{1,2}\.\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ]|$)/g)) {
    const produto = interpretarNcm([m[2]!]).inclusoes[0];
    if (produto !== undefined) {
      anexoII.push({ item: Number(m[1]), produto, texto: m[2]!.trim() });
    }
  }

  return { anexoI, anexoII };
}

const ROTULO: Record<string, string> = {
  combustiveis: 'combustíveis',
  farmacos: 'produtos farmacêuticos',
  perfumaria: 'perfumaria, toucador ou higiene pessoal',
  veiculos: 'veículos e máquinas autopropulsadas',
  autopecas: 'autopeças',
  pneus: 'pneus e câmaras-de-ar',
  bebidas_frias: 'bebidas frias (Lei nº 13.097/2015)',
};

/**
 * Monta as linhas de `ncm_flags` dos registros vigentes em `hoje`.
 *
 * Um NCM citado por mais de um registro fica com uma linha só: a vigência mais
 * antiga e as notas juntas. Ressalva de ex-tarifário ou de destino só fica se
 * **nenhuma** fonte citar o NCM sem ressalva — o incondicional vence.
 */
export function montarFlags(
  registros: readonly Registro[],
  anexos: AnexosLei10485 | null,
  ncmsOficiais: readonly string[],
  hoje: string,
  fonte: string,
): Montagem {
  const acumulado = new Map<string, { validFrom: string; origens: Set<string>; ressalvas: Set<string> | null }>();
  const semCorrespondencia: Montagem['semCorrespondencia'] = [];
  const remissoesNaoLidas: Montagem['remissoesNaoLidas'] = [];

  const marcar = (ncms: Map<string, string | null>, origem: string, desde: string): void => {
    for (const [ncm, ressalva] of ncms) {
      const atual = acumulado.get(ncm) ?? { validFrom: desde, origens: new Set(), ressalvas: new Set() };
      atual.validFrom = desde < atual.validFrom ? desde : atual.validFrom;
      atual.origens.add(origem);
      if (ressalva === null) {
        atual.ressalvas = null;
      } else if (atual.ressalvas !== null) {
        atual.ressalvas.add(ressalva);
      }
      acumulado.set(ncm, atual);
    }
  };

  for (const registro of registros) {
    const grupo = grupoMonofasico(registro.codigo);
    const periodo = periodoVigente(registro, hoje);
    if (grupo === null || periodo === undefined) {
      continue;
    }
    const origem = `código ${registro.codigo}, ${ROTULO[grupo]}`;
    const interpretado = interpretarNcm(registro.ncm);

    if (interpretado.remissao !== null) {
      if (/10\.485/.test(interpretado.remissao) && anexos !== null) {
        const i = expandir(anexos.anexoI, ncmsOficiais);
        marcar(i.ncms, `${origem} · Lei nº 10.485/2002, Anexo I`, periodo.inicio);
        semCorrespondencia.push(...i.semCorrespondencia.map((prefixo) => ({ origem: 'Anexo I', prefixo })));

        for (const item of anexos.anexoII) {
          const r = expandir({ inclusoes: [item.produto], exclusoes: [], remissao: null }, ncmsOficiais);
          const condicao = `Anexo II, item ${item.item}: só com o destino que o item define`;
          marcar(
            new Map([...r.ncms].map(([ncm, ex]) => [ncm, ex === null ? condicao : `${condicao}; ${ex}`])),
            `${origem} · Lei nº 10.485/2002, Anexo II`,
            periodo.inicio,
          );
          semCorrespondencia.push(
            ...r.semCorrespondencia.map((prefixo) => ({ origem: `Anexo II, item ${item.item}`, prefixo })),
          );
        }
      } else if (interpretado.remissao !== '-') {
        remissoesNaoLidas.push({ codigo: registro.codigo, texto: interpretado.remissao });
      }
      continue;
    }

    const r = expandir(interpretado, ncmsOficiais);
    marcar(r.ncms, origem, periodo.inicio);
    semCorrespondencia.push(
      ...r.semCorrespondencia.map((prefixo) => ({ origem: `código ${registro.codigo}`, prefixo })),
    );
  }

  const linhas = [...acumulado]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ncm, a]) => ({
      ncm,
      validFrom: a.validFrom,
      note:
        `${fonte} · ${[...a.origens].join('; ')}` +
        (a.ressalvas === null || a.ressalvas.size === 0 ? '' : ` · ${[...a.ressalvas].join('; ')}`),
    }));

  // Os códigos 302 e 303 citam os mesmos anexos: o mesmo prefixo sem
  // correspondência apareceria duas vezes.
  const unicos = [...new Map(semCorrespondencia.map((s) => [`${s.origem}|${s.prefixo}`, s])).values()];

  return { linhas, semCorrespondencia: unicos, remissoesNaoLidas };
}
