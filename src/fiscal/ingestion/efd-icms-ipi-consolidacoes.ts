/**
 * Registros da EFD ICMS/IPI que lançam ICMS na apuração fora do `C100`.
 *
 * O `E110` soma, nos débitos, o `VL_ICMS` de C190, C320, C390, C490, C590,
 * C690, C790, C850, C890, D190, D300, D390, D410, D590, D690, D696, D730 e
 * D760; nos créditos, o de C190, C590, D190, D590 e D730 (validação dos campos
 * 02 e 06 do `E110`, Guia Prático 3.2.2). Este leitor cobre os que estão em
 * `ANALITICOS_LIDOS`; os demais continuam impedindo a conferência da soma.
 *
 * As posições saíram dos guias 3.1.9 e 3.2.2 (idênticas nos dois), extraídas por
 * `scripts/extrair-layout-efd.ts`. Nas tabelas que a conversão do PDF truncou
 * (`D100`, `D190`, `C790`), foram conferidas no texto do guia convertido com
 * `pdftotext -layout`.
 */
import { centavos, numero, texto } from '../shared/sped-campos.js';

/**
 * Analítico de ICMS fora do C190: `C320`, `C390`, `C490`, `C590`, `C690`,
 * `C790`, `C890`, `D190` e `D590`. Em todos, os campos 2 a 7 são os mesmos:
 * `CST_ICMS`, `CFOP`, `ALIQ_ICMS`, `VL_OPR`, `VL_BC_ICMS` e `VL_ICMS`.
 */
export interface EfdIcmsAnalyticLine {
  cstIcms: string;
  cfop: string;
  icmsRate: number;
  operationCents: number;
  icmsBaseCents: number;
  icmsCents: number;
}

/**
 * Documento ou consolidação fora do C100 que lança ICMS na apuração.
 *
 * `C590`, `D190` e `D590` pertencem a um documento (`C500`, `D100`, `D500`),
 * que dá o sentido e a situação. Os demais só existem em saída (o guia os lista
 * só nos débitos do E110) e não têm situação por documento: vêm agregados, um
 * por registro.
 */
export interface EfdIcmsConsolidation {
  /** O analítico somado: `C590`, `D190`, `C490`... */
  record: string;
  line: number;
  operation: 'inbound' | 'outbound';
  situation: string;
  subject: string;
  /** `VL_ICMS` do documento pai, quando há um. */
  documentIcmsCents: number | null;
  analytics: EfdIcmsAnalyticLine[];
}

/** Analíticos que este leitor soma, além do `C190`. */
export const ANALITICOS_LIDOS: ReadonlySet<string> = new Set([
  'C320', 'C390', 'C490', 'C590', 'C690', 'C790', 'C890', 'D190', 'D590',
]);

/** Analíticos só de saída, sem situação por documento: agregados por registro. */
const SO_SAIDA = new Set(['C320', 'C390', 'C490', 'C690', 'C790', 'C890']);

/**
 * Acumula as consolidações enquanto o leitor percorre o arquivo. `ler` ignora o
 * registro que não é dela, e lança no que está fora de lugar, para a linha ir
 * para `rejected` com o motivo.
 */
export class LeituraDeConsolidacoes {
  readonly consolidations: EfdIcmsConsolidation[] = [];
  /** Documento pai aberto de cada família. */
  private readonly pais: Partial<Record<string, EfdIcmsConsolidation>> = {};
  private readonly agregados: Partial<Record<string, EfdIcmsConsolidation>> = {};

  ler(registro: string, campos: readonly string[], linha: number): void {
    if (registro in ANALITICO_DO_PAI) {
      // Sai antes de ler: pai recusado não pode deixar o anterior aberto, e os
      // analíticos dele irem parar no documento errado.
      delete this.pais[registro];
      const pai = lerPai(registro, campos, linha);
      this.pais[registro] = pai;
      this.consolidations.push(pai);
      return;
    }

    const paiEsperado = PAI_DO_ANALITICO[registro];
    if (paiEsperado !== undefined) {
      const pai = this.pais[paiEsperado];
      if (pai === undefined) {
        throw new Error(`Registro ${registro} fora de um documento ${paiEsperado}.`);
      }
      pai.analytics.push(lerAnaliticoIcms(campos));
      return;
    }

    if (SO_SAIDA.has(registro)) {
      let agregado = this.agregados[registro];
      if (agregado === undefined) {
        agregado = {
          record: registro,
          line: linha,
          operation: 'outbound',
          situation: '00',
          subject: `registros ${registro}`,
          documentIcmsCents: null,
          analytics: [],
        };
        this.agregados[registro] = agregado;
        this.consolidations.push(agregado);
      }
      agregado.analytics.push(lerAnaliticoIcms(campos));
    }
  }
}

const PAI_DO_ANALITICO: Readonly<Record<string, string>> = {
  C590: 'C500',
  D190: 'D100',
  D590: 'D500',
};

/**
 * Posições do documento pai, do guia:
 *
 * | Registro | IND_OPER | COD_MOD | COD_SIT | NUM_DOC | VL_ICMS |
 * |----------|----------|---------|---------|---------|---------|
 * | `C500`   | 2        | 5       | 6       | 10      | 20      |
 * | `D100`   | 2        | 5       | 6       | 9       | 20      |
 * | `D500`   | 2        | 5       | 6       | 9       | 19      |
 *
 * O `D100` traz a chave do CT-e no campo 10, e ela é o melhor apontamento.
 */
function lerPai(registro: string, campos: readonly string[], linha: number): EfdIcmsConsolidation {
  const posicoes: Record<string, { numero: number; icms: number }> = {
    C500: { numero: 10, icms: 20 },
    D100: { numero: 9, icms: 20 },
    D500: { numero: 9, icms: 19 },
  };
  const { numero: pNumero, icms: pIcms } = posicoes[registro]!;
  const chave = registro === 'D100' ? texto(campos[10]) : '';
  const numeroDoc = texto(campos[pNumero]);

  return {
    record: ANALITICO_DO_PAI[registro]!,
    line: linha,
    operation: texto(campos[2]) === '1' ? 'outbound' : 'inbound',
    situation: texto(campos[6]),
    subject: chave !== '' ? chave : `${registro} modelo ${texto(campos[5])} nº ${numeroDoc || 's/n'}`,
    documentIcmsCents: centavos(campos[pIcms], 'VL_ICMS'),
    analytics: [],
  };
}

const ANALITICO_DO_PAI: Readonly<Record<string, string>> = {
  C500: 'C590',
  D100: 'D190',
  D500: 'D590',
};

/** Campos 2 a 7, comuns a todos os analíticos de ICMS (ver `EfdIcmsAnalyticLine`). */
function lerAnaliticoIcms(campos: readonly string[]): EfdIcmsAnalyticLine {
  return {
    cstIcms: texto(campos[2]),
    cfop: texto(campos[3]),
    icmsRate: numero(campos[4], 'ALIQ_ICMS'),
    operationCents: centavos(campos[5], 'VL_OPR'),
    icmsBaseCents: centavos(campos[6], 'VL_BC_ICMS'),
    icmsCents: centavos(campos[7], 'VL_ICMS'),
  };
}

