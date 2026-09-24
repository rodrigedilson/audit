import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { isValidAccessKey, parseAccessKey } from './access-key.js';

/**
 * Parse de NF-e / NFC-e. Camadas 1 e 2 do pipeline no domínio fiscal: sintaxe
 * XML e conformidade mínima de leiaute.
 *
 * Extrai os tributos atuais **e** o grupo UB (IBS/CBS, NT 2025.002) do mesmo
 * item. É o que permite a apuração dual velho/novo nota a nota — o diferencial
 * que nenhum concorrente entrega, porque todos olham um dos dois lados.
 */

export interface TaxLine {
  cst?: string;
  baseCents: number;
  rate: number;
  amountCents: number;
}

export interface ParsedItem {
  line: number;
  code: string;
  description: string;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  /** Tributos do sistema atual, como destacados no documento. */
  legacy: {
    icms?: TaxLine;
    ipi?: TaxLine;
    pis?: TaxLine;
    cofins?: TaxLine;
  };
  /** Grupo UB: IBS/CBS. Ausente em documento emitido antes da obrigatoriedade. */
  reform?: {
    cst?: string;
    cclasstrib?: string;
    ibsUf?: TaxLine;
    ibsMun?: TaxLine;
    cbs?: TaxLine;
  };
}

export interface ParsedDocument {
  accessKey: string;
  model: 'nfe' | 'nfce';
  series: string;
  number: string;
  issuedAt: string;
  /** Competência derivada da data de emissão, não da chave. */
  period: string;
  issuerCnpj: string;
  issuerName: string;
  recipientCnpj?: string;
  recipientName?: string;
  totalCents: number;
  items: ParsedItem[];
  /** `true` quando o documento traz o grupo UB em pelo menos um item. */
  hasReformGroup: boolean;
}

export type ParseFailureReason =
  | 'schema_violation'
  | 'unknown_code'
  | 'duplicate_document'
  | 'sequence_gap';

export class DocumentParseError extends Error {
  constructor(
    readonly reason: ParseFailureReason,
    readonly layer: 1 | 2,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Números fiscais vêm como string e são convertidos com precisão controlada:
  // o parser automático transformaria "0000000015" em 15 e quantidades como
  // "1.0000" em 1, perdendo a forma original do documento.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function parseNfe(xml: string): ParsedDocument {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new DocumentParseError(
      'schema_violation',
      1,
      `XML malformado na linha ${validation.err.line}: ${validation.err.msg}`,
    );
  }

  const root = parser.parse(xml) as Record<string, unknown>;
  const infNFe = findInfNFe(root);

  if (!infNFe) {
    throw new DocumentParseError(
      'schema_violation',
      2,
      'Documento não contém o grupo infNFe. Não é um XML de NF-e/NFC-e.',
    );
  }

  const accessKey = readAccessKey(infNFe);
  const ide = asRecord(infNFe['ide']);
  const emit = asRecord(infNFe['emit']);
  const dest = asRecord(infNFe['dest']);
  const total = asRecord(asRecord(infNFe['total'])?.['ICMSTot']);

  const issuedAtRaw = text(ide?.['dhEmi']) ?? text(ide?.['dEmi']);
  if (!issuedAtRaw) {
    throw new DocumentParseError('schema_violation', 2, 'Documento sem data de emissão (dhEmi).');
  }

  const issuedAt = new Date(issuedAtRaw);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new DocumentParseError(
      'schema_violation',
      2,
      `Data de emissão inválida: '${issuedAtRaw}'.`,
    );
  }

  const issuerCnpj = inscricao(text(emit?.['CNPJ']));
  if (issuerCnpj === undefined) {
    throw new DocumentParseError(
      'schema_violation',
      2,
      'Emitente sem CNPJ de 14 posições.',
    );
  }

  // A chave carrega o CNPJ do emitente; divergir dela significa documento
  // remontado ou chave de outra nota colada no arquivo.
  const keyParts = parseAccessKey(accessKey);
  if (keyParts.issuerCnpj !== issuerCnpj) {
    throw new DocumentParseError(
      'schema_violation',
      2,
      `CNPJ do emitente (${issuerCnpj}) não corresponde ao da chave de acesso ` +
        `(${keyParts.issuerCnpj}).`,
    );
  }

  const items = readItems(infNFe);
  if (items.length === 0) {
    throw new DocumentParseError('schema_violation', 2, 'Documento sem itens (grupo det).');
  }

  const modelCode = keyParts.model;
  const recipientCnpj = inscricao(text(dest?.['CNPJ'])) ?? '';
  const recipientName = text(dest?.['xNome']);

  return {
    accessKey,
    model: modelCode === '65' ? 'nfce' : 'nfe',
    series: text(ide?.['serie']) ?? keyParts.series,
    number: text(ide?.['nNF']) ?? keyParts.number,
    issuedAt: issuedAt.toISOString(),
    period: issuedAt.toISOString().slice(0, 7),
    issuerCnpj,
    issuerName: text(emit?.['xNome']) ?? '',
    ...(recipientCnpj.length === 14 ? { recipientCnpj } : {}),
    ...(recipientName === undefined ? {} : { recipientName }),
    totalCents: cents(text(total?.['vNF'])),
    items,
    hasReformGroup: items.some((item) => item.reform !== undefined),
  };
}

function readAccessKey(infNFe: Record<string, unknown>): string {
  /*
   * O Id vem como "NFe" seguido das 44 posições da chave.
   *
   * Antes bastava filtrar para dígitos, o que descartava o prefixo de brinde.
   * Com a chave podendo ter letras nas doze posições do CNPJ, filtrar assim
   * deixaria "NFE" colado no começo da chave — o prefixo agora sai explícito.
   * Nenhuma chave real começa por letra: as duas primeiras posições são o código
   * numérico da UF.
   */
  const raw = (text(infNFe['@Id']) ?? '')
    .trim()
    .toUpperCase()
    .replace(/^NFE/, '')
    .replace(/[^0-9A-Z]/g, '');

  if (!isValidAccessKey(raw)) {
    throw new DocumentParseError(
      'schema_violation',
      2,
      raw.length === 44
        ? 'Chave de acesso com dígito verificador inválido.'
        : `Chave de acesso ausente ou com tamanho inválido (${raw.length} posições).`,
    );
  }

  return raw;
}

function readItems(infNFe: Record<string, unknown>): ParsedItem[] {
  return toArray(infNFe['det']).map((raw, index) => {
    const det = asRecord(raw) ?? {};
    const prod = asRecord(det['prod']) ?? {};
    const imposto = asRecord(det['imposto']) ?? {};

    const quantity = Number(text(prod['qCom']) ?? '0');
    const item: ParsedItem = {
      line: Number(text(det['@nItem']) ?? String(index + 1)),
      code: text(prod['cProd']) ?? '',
      description: text(prod['xProd']) ?? '',
      ncm: text(prod['NCM']) ?? '',
      cfop: text(prod['CFOP']) ?? '',
      unit: text(prod['uCom']) ?? '',
      quantity: Number.isFinite(quantity) ? quantity : 0,
      unitPriceCents: cents(text(prod['vUnCom'])),
      totalCents: cents(text(prod['vProd'])),
      legacy: {
        ...optionalTax('icms', readIcms(imposto)),
        ...optionalTax('ipi', readNestedTax(imposto['IPI'], 'vBC', 'pIPI', 'vIPI')),
        ...optionalTax('pis', readNestedTax(imposto['PIS'], 'vBC', 'pPIS', 'vPIS')),
        ...optionalTax('cofins', readNestedTax(imposto['COFINS'], 'vBC', 'pCOFINS', 'vCOFINS')),
      },
    };

    const reform = readReformGroup(imposto);
    if (reform) {
      item.reform = reform;
    }

    return item;
  });
}

/** ICMS vem dentro de um subgrupo por tributação (ICMS00, ICMS20, ICMSSN102…). */
function readIcms(imposto: Record<string, unknown>): TaxLine | undefined {
  const icms = asRecord(imposto['ICMS']);
  if (!icms) {
    return undefined;
  }

  for (const value of Object.values(icms)) {
    const group = asRecord(value);
    if (!group) {
      continue;
    }
    return {
      ...optional('cst', text(group['CST']) ?? text(group['CSOSN'])),
      baseCents: cents(text(group['vBC'])),
      rate: Number(text(group['pICMS']) ?? '0'),
      amountCents: cents(text(group['vICMS'])),
    };
  }

  return undefined;
}

function readNestedTax(
  raw: unknown,
  baseTag: string,
  rateTag: string,
  amountTag: string,
): TaxLine | undefined {
  const outer = asRecord(raw);
  if (!outer) {
    return undefined;
  }

  for (const value of Object.values(outer)) {
    const group = asRecord(value);
    if (!group) {
      continue;
    }
    return {
      ...optional('cst', text(group['CST'])),
      baseCents: cents(text(group[baseTag])),
      rate: Number(text(group[rateTag]) ?? '0'),
      amountCents: cents(text(group[amountTag])),
    };
  }

  return undefined;
}

/**
 * Grupo UB da NT 2025.002: CST-IBS/CBS, cClassTrib e os três tributos novos
 * (IBS estadual, IBS municipal e CBS). Ausente em documento emitido antes da
 * obrigatoriedade — por isso é opcional, não obrigatório.
 */
function readReformGroup(imposto: Record<string, unknown>): ParsedItem['reform'] | undefined {
  const ibsCbs = asRecord(imposto['IBSCBS']);
  if (!ibsCbs) {
    return undefined;
  }

  const group = asRecord(ibsCbs['gIBSCBS']) ?? ibsCbs;
  const ibs = asRecord(group['gIBS']);

  const reform: NonNullable<ParsedItem['reform']> = {
    ...optional('cst', text(ibsCbs['CST'])),
    ...optional('cclasstrib', text(ibsCbs['cClassTrib'])),
  };

  const ibsUf = readReformTax(asRecord(ibs?.['gIBSUF']), 'pIBSUF', 'vIBSUF', group);
  const ibsMun = readReformTax(asRecord(ibs?.['gIBSMun']), 'pIBSMun', 'vIBSMun', group);
  const cbs = readReformTax(asRecord(group['gCBS']), 'pCBS', 'vCBS', group);

  if (ibsUf) reform.ibsUf = ibsUf;
  if (ibsMun) reform.ibsMun = ibsMun;
  if (cbs) reform.cbs = cbs;

  return reform;
}

function readReformTax(
  node: Record<string, unknown> | undefined,
  rateTag: string,
  amountTag: string,
  parent: Record<string, unknown>,
): TaxLine | undefined {
  if (!node) {
    return undefined;
  }
  return {
    // A base do IBS/CBS é declarada uma vez no grupo, não por tributo.
    baseCents: cents(text(parent['vBC'])),
    rate: Number(text(node[rateTag]) ?? '0'),
    amountCents: cents(text(node[amountTag])),
  };
}

// ------------------------------------------------------------------ helpers

function findInfNFe(root: Record<string, unknown>): Record<string, unknown> | undefined {
  // O XML chega como nfeProc>NFe>infNFe (autorizado) ou NFe>infNFe (só assinado).
  const candidates = [
    asRecord(asRecord(asRecord(root['nfeProc'])?.['NFe'])?.['infNFe']),
    asRecord(asRecord(root['NFe'])?.['infNFe']),
    asRecord(root['infNFe']),
  ];

  return candidates.find((candidate) => candidate !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

/**
 * CNPJ do XML: 14 posições, sendo as duas últimas numéricas.
 *
 * Não filtra para dígitos. Desde 31/07/2026 a Receita emite CNPJ alfanumérico, e
 * a Nota Técnica Conjunta CNPJ Alfanumérico 2025.001 abriu o campo no DF-e.
 * Devolve `undefined` quando não há CNPJ válido, para que quem chama decida se
 * isso é erro — no emitente é, no destinatário nem sempre (venda a consumidor).
 */
function inscricao(value: string | undefined): string | undefined {
  const limpo = (value ?? '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(limpo) ? limpo : undefined;
}

/**
 * Valores fiscais em centavos inteiros. `Math.round` sobre o produto evita que
 * "10.99" vire 1098 por erro de ponto flutuante — num total de milhares de itens
 * esse centavo aparece na apuração.
 */
function cents(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function optionalTax<K extends string>(
  key: K,
  value: TaxLine | undefined,
): Partial<Record<K, TaxLine>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, TaxLine>);
}
