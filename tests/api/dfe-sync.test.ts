import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import type { SefazDfeGateway } from '../../src/fiscal/dfe/sefaz-gateway.js';
import {
  lerRespostaDistribuicao,
  lerRespostaEvento,
  type PedidoCiencia,
  type PedidoDistribuicao,
  type RespostaDistribuicao,
  type RespostaEvento,
} from '../../src/fiscal/dfe/dfe-xml.js';
import type { CredencialA1 } from '../../src/fiscal/portfolio/certificate-vault.js';
import { computeCheckDigit } from '../../src/fiscal/ingestion/access-key.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { pfxDeTeste } from '../helpers/certificado.js';
import { respostaDistribuicao, respostaEvento, resNFe } from '../helpers/sefaz.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';

function chave(emitente: string, numero: string): string {
  const base = '35' + '2711' + emitente + '55' + '001' + numero.padStart(9, '0') + '1' + '23456789';
  return base + computeCheckDigit(base);
}

function procNFe(emitente: string, destinatario: string, numero: string): string {
  const key = chave(emitente, numero);
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>${numero}</nNF><dhEmi>2027-11-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${emitente}</CNPJ><xNome>FORNECEDOR</xNome></emit>
  <dest><CNPJ>${destinatario}</CNPJ><xNome>CLIENTE</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto><ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS></imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

/**
 * SEFAZ dublada: devolve as respostas da fila, na ordem, e grava o que a
 * coleta pediu. As respostas passam pelo mesmo parser da resposta real.
 */
class SefazDublada implements SefazDfeGateway {
  distribuicoes: string[] = [];
  eventos: string[] = [];
  pedidos: PedidoDistribuicao[] = [];
  ciencias: PedidoCiencia[] = [];
  credenciais: CredencialA1[] = [];

  async distribuir(credencial: CredencialA1, pedido: PedidoDistribuicao): Promise<RespostaDistribuicao> {
    this.credenciais.push(credencial);
    this.pedidos.push(pedido);
    const proxima = this.distribuicoes.shift() ?? respostaDistribuicao('137', [], pedido.ultNsu, pedido.ultNsu);
    return lerRespostaDistribuicao(proxima);
  }

  async manifestarCiencia(_c: CredencialA1, pedido: PedidoCiencia): Promise<RespostaEvento> {
    this.ciencias.push(pedido);
    return lerRespostaEvento(this.eventos.shift() ?? respostaEvento('135'));
  }
}

describe.skipIf(!DATABASE_URL)('API — coleta de DF-e na SEFAZ (ADR-006)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let semSefaz: FastifyInstance;
  let sefaz: SefazDublada;
  let tenantId: string;
  let owner: string;
  let viewer: string;
  let cnpj: string;
  let fornecedor: string;

  const token = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (method: 'GET' | 'POST', url: string, userId = owner, servidor = app) =>
    servidor.inject({ method, url, headers: { authorization: `Bearer ${await token(userId)}` } });

  const guardarCertificado = async (): Promise<void> => {
    const form = new FormData();
    form.append('pfx', pfxDeTeste({ password: 'senha-do-pfx', comCadeia: true }), { filename: 'cert.pfx' });
    form.append('password', 'senha-do-pfx');
    const r = await app.inject({
      method: 'PUT',
      url: `/v1/clients/${cnpj}/certificate`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await token(owner)}` },
      payload: form,
    });
    if (r.statusCode !== 200) throw new Error(`certificado: ${r.statusCode} ${r.body}`);
  };

  /** Enfileira e executa o job, como o worker faria. */
  const coletar = async (): Promise<Record<string, unknown>> => {
    const r = await call('POST', `/v1/clients/${cnpj}/sync`);
    if (r.statusCode !== 202) throw new Error(`sync: ${r.statusCode} ${r.body}`);
    // A fila é global, e outros arquivos de teste também gravam em `jobs`:
    // executa até chegar ao job deste pedido, como o worker faria.
    const alvo = r.json().job_id as string;
    for (let i = 0; i < 20; i += 1) {
      const executado = await app.dfeSync!.runNext();
      if (executado === alvo || executado === null) break;
    }
    const job = (await call('GET', `/v1/jobs/${alvo}`)).json();
    if (job.status === 'queued' || job.status === 'running') {
      throw new Error(`o job ${alvo} não foi executado: ${JSON.stringify(job)}`);
    }
    return job;
  };

  const eventos = async (acao: string) =>
    (
      await pool.query<{ payload: Record<string, unknown>; actor: string }>(
        'select payload, actor from events where tenant_id = $1::uuid and cnpj = $2::char(14) and action = $3 order by event_seq',
        [tenantId, cnpj, acao],
      )
    ).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const env = loadEnv({
      AUDIT_ENV: 'dev',
      DATABASE_URL,
      SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
      SUPABASE_ANON_KEY: 'chave-anon-de-teste',
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_JWT_AUDIENCE: AUDIENCE,
      CERTIFICATE_MASTER_KEY: 'chave-mestra-de-teste-com-mais-de-32-caracteres',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    sefaz = new SefazDublada();
    app = await buildServer({ env, pool, sefaz });
    semSefaz = await buildServer({ env, pool });
    await Promise.all([app.ready(), semSefaz.ready()]);
  });

  afterAll(async () => {
    await app?.close();
    await semSefaz?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    tenantId = await createTenant(pool, 'Escritório da Coleta');
    owner = await createMembership(pool, tenantId, 'owner');
    viewer = await createMembership(pool, tenantId, 'viewer');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();
    await createClient(pool, tenantId, cnpj);
    await pool.query("update clients set uf = 'SP' where tenant_id = $1::uuid and cnpj = $2::char(14)", [tenantId, cnpj]);
    // A fila é global e na ordem de chegada. Os testes de pedido enfileiram sem
    // executar, e só este arquivo cria jobs de coleta: esvaziar aqui é o que
    // faz cada teste executar o próprio job.
    await pool.query(
      "update jobs set status = 'failed', error = 'limpeza do teste' where kind = 'dfe_sync' and status in ('queued', 'running')",
    );
    sefaz.distribuicoes = [];
    sefaz.eventos = [];
    sefaz.pedidos = [];
    sefaz.ciencias = [];
    sefaz.credenciais = [];
  });

  describe('pedido', () => {
    /** Dev não fala com a SEFAZ: o banco é o de produção. */
    it('sem gateway, 503 dizendo por quê', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/sync`, owner, semSefaz);

      expect(r.statusCode).toBe(503);
      expect(r.json().code).toBe('dfe_gateway_not_configured');
    });

    it('sem certificado, 409', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/sync`);
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe('dfe_no_certificate');
    });

    it('certificado guardado antes da coleta (PFX com senha descartada) pede reenvio', async () => {
      await guardarCertificado();
      await pool.query(
        "update certificates set credential_format = 'pfx_protected' where tenant_id = $1::uuid and cnpj = $2::char(14)",
        [tenantId, cnpj],
      );

      const r = await call('POST', `/v1/clients/${cnpj}/sync`);
      expect(r.statusCode).toBe(409);
      expect(r.json().message).toMatch(/Reenvie o certificado/);
    });

    it('cliente sem UF, 409: a distribuição exige cUFAutor', async () => {
      await guardarCertificado();
      await pool.query('update clients set uf = null where tenant_id = $1::uuid and cnpj = $2::char(14)', [tenantId, cnpj]);

      expect((await call('POST', `/v1/clients/${cnpj}/sync`)).json().code).toBe('dfe_missing_uf');
    });

    it('enfileira com 202, e o segundo pedido devolve o mesmo job', async () => {
      await guardarCertificado();
      const a = await call('POST', `/v1/clients/${cnpj}/sync`);
      const b = await call('POST', `/v1/clients/${cnpj}/sync`);

      expect(a.statusCode).toBe(202);
      expect(b.json()).toMatchObject({ job_id: a.json().job_id, reused: true });
    });

    it('viewer não pede coleta', async () => {
      await guardarCertificado();
      expect((await call('POST', `/v1/clients/${cnpj}/sync`, viewer)).statusCode).toBe(403);
    });

    it('GET /certificate diz se o certificado serve para a coleta', async () => {
      await guardarCertificado();
      expect((await call('GET', `/v1/clients/${cnpj}/certificate`)).json().usable_for_sync).toBe(true);
    });
  });

  describe('execução', () => {
    beforeEach(guardarCertificado);

    it('consulta por NSU com o A1 decifrado, e usa a UF do cliente', async () => {
      const job = await coletar();

      expect(job.status).toBe('done');
      expect(sefaz.pedidos[0]).toMatchObject({ tpAmb: 1, cUFAutor: '35', cnpj, ultNsu: '000000000000000' });
      expect(sefaz.credenciais[0]!.cert).toContain('BEGIN CERTIFICATE');
    });

    const abrirCompetencia = async (): Promise<void> => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/periods`,
        headers: { authorization: `Bearer ${await token(owner)}` },
        payload: { period: '2027-11' },
      });
      if (r.statusCode !== 201) throw new Error(`competência: ${r.statusCode} ${r.body}`);
    };

    it('NF-e completa entra pelo mesmo caminho do upload, com doc.received', async () => {
      await abrirCompetencia();
      sefaz.distribuicoes = [
        respostaDistribuicao('138', [{ nsu: '000000000000001', schema: 'procNFe_v4.00.xsd', xml: procNFe(fornecedor, cnpj, '15') }], '000000000000001', '000000000000001'),
      ];

      const job = await coletar();

      expect(job).toMatchObject({ status: 'done', accepted: 1 });
      const { rowCount } = await pool.query(
        'select 1 from documents where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3',
        [tenantId, cnpj, chave(fornecedor, '15')],
      );
      expect(rowCount).toBe(1);
      expect(await eventos('doc.received')).toHaveLength(1);
    });

    /** Reingerir gravaria um output.rejected de duplicata no log append-only. */
    it('nota já subida à mão não é reingerida nem vira rejeição no log', async () => {
      await abrirCompetencia();
      const xml = procNFe(fornecedor, cnpj, '16');
      const form = new FormData();
      form.append('files', Buffer.from(xml), { filename: 'n.xml' });
      await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/documents`,
        headers: { ...form.getHeaders(), authorization: `Bearer ${await token(owner)}` },
        payload: form,
      });
      sefaz.distribuicoes = [respostaDistribuicao('138', [{ nsu: '1', schema: 'procNFe_v4.00.xsd', xml }], '000000000000001', '000000000000001')];

      const job = await coletar();

      expect((job.result as Record<string, number>).already_present).toBe(1);
      expect(await eventos('output.rejected')).toHaveLength(0);
    });

    /**
     * A distribuição traz 90 dias de qualquer mês. Nota de competência não
     * aberta não pode virar output.rejected permanente: espera, e entra depois.
     */
    it('nota de competência não aberta espera, sem rejeição, e entra depois da abertura', async () => {
      sefaz.distribuicoes = [
        respostaDistribuicao('138', [{ nsu: '1', schema: 'procNFe_v4.00.xsd', xml: procNFe(fornecedor, cnpj, '22') }], '000000000000001', '000000000000001'),
      ];

      const primeira = await coletar();
      expect((primeira.result as Record<string, number>).awaiting_period).toBe(1);
      expect(await eventos('output.rejected')).toHaveLength(0);
      expect((await call('GET', `/v1/clients/${cnpj}/dfe`)).json().documents.awaiting_period_open).toBe(1);

      await abrirCompetencia();
      // A fila da SEFAZ já foi alcançada: libera o bloqueio de uma hora para a
      // segunda coleta, como aconteceria depois dela.
      await pool.query('update dfe_sync_state set blocked_until = null where tenant_id = $1::uuid and cnpj = $2::char(14)', [tenantId, cnpj]);
      const segunda = await coletar();

      expect(segunda.accepted).toBe(1);
      expect(await eventos('doc.received')).toHaveLength(1);
      expect((await call('GET', `/v1/clients/${cnpj}/dfe`)).json().documents.awaiting_period_open).toBe(0);
    });

    it('resumo de entrada recebe a ciência da operação, e fica registrado', async () => {
      const k = chave(fornecedor, '17');
      sefaz.distribuicoes = [respostaDistribuicao('138', [{ nsu: '1', schema: 'resNFe_v1.01.xsd', xml: resNFe(k) }], '000000000000001', '000000000000001')];

      const job = await coletar();

      expect((job.result as Record<string, number>).ciencias).toBe(1);
      expect(sefaz.ciencias[0]).toMatchObject({ tpAmb: 1, cnpj, accessKey: k });
      const { rows } = await pool.query(
        'select manifest_cstat, manifested_at from dfe_summaries where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3',
        [tenantId, cnpj, k],
      );
      expect(rows[0].manifest_cstat).toBe('135');
      expect(rows[0].manifested_at).not.toBeNull();
    });

    it('573 (ciência já registrada) conta como ciência', async () => {
      sefaz.distribuicoes = [respostaDistribuicao('138', [{ nsu: '1', schema: 'resNFe_v1.01.xsd', xml: resNFe(chave(fornecedor, '18')) }], '000000000000001', '000000000000001')];
      sefaz.eventos = [respostaEvento('573')];

      expect(((await coletar()).result as Record<string, number>).ciencias).toBe(1);
    });

    it('ciência recusada fica com o motivo, e a coleta termina', async () => {
      sefaz.distribuicoes = [respostaDistribuicao('138', [{ nsu: '1', schema: 'resNFe_v1.01.xsd', xml: resNFe(chave(fornecedor, '19')) }], '000000000000001', '000000000000001')];
      sefaz.eventos = [respostaEvento('', '215')];

      const job = await coletar();

      expect(job.status).toBe('done');
      expect((job.result as Record<string, number>).ciencia_failures).toBe(1);
      expect((await call('GET', `/v1/clients/${cnpj}/dfe`)).json().summaries.acknowledgement_failed).toBe(1);
    });

    /** O log de uso do A1 é onde mais importa saber quem agiu. */
    it('cada chamada à SEFAZ vira certificate.used, em nome de quem pediu', async () => {
      sefaz.distribuicoes = [respostaDistribuicao('138', [{ nsu: '1', schema: 'resNFe_v1.01.xsd', xml: resNFe(chave(fornecedor, '20')) }], '000000000000001', '000000000000001')];

      await coletar();

      const usos = await eventos('certificate.used');
      expect(usos.map((u) => u.payload['purpose'])).toEqual(['dfe_distribution', 'manifestation']);
      expect(usos.every((u) => u.actor === owner)).toBe(true);
      expect(usos.every((u) => u.payload['outcome'] === 'success')).toBe(true);
    });

    it('consulta em laço até alcançar o maxNSU, e continua do NSU salvo', async () => {
      sefaz.distribuicoes = [
        respostaDistribuicao('138', [], '000000000000050', '000000000000100'),
        respostaDistribuicao('138', [], '000000000000100', '000000000000100'),
      ];

      await coletar();

      expect(sefaz.pedidos.map((p) => p.ultNsu)).toEqual(['000000000000000', '000000000000050']);
      expect((await call('GET', `/v1/clients/${cnpj}/dfe`)).json().ult_nsu).toBe('000000000000100');
    });

    /** Pedir de novo antes de uma hora conta como consumo indevido na SEFAZ. */
    it('alcançada a fila, o próximo pedido é 429 com o horário', async () => {
      await coletar();

      const r = await call('POST', `/v1/clients/${cnpj}/sync`);
      expect(r.statusCode).toBe(429);
      expect(r.json().code).toBe('dfe_sync_blocked');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(3000);
    });

    it('656 (consumo indevido) bloqueia por uma hora e não processa o lote', async () => {
      sefaz.distribuicoes = [respostaDistribuicao('656', [{ nsu: '1', schema: 'procNFe_v4.00.xsd', xml: procNFe(fornecedor, cnpj, '21') }])];

      const job = await coletar();

      expect(job.status).toBe('done');
      expect((job.result as Record<string, unknown>).blocked_until).not.toBeNull();
      expect(await eventos('doc.received')).toHaveLength(0);
      expect((await call('POST', `/v1/clients/${cnpj}/sync`)).statusCode).toBe(429);
    });

    it('cStat de erro falha o job com o motivo da SEFAZ', async () => {
      sefaz.distribuicoes = [respostaDistribuicao('593')];

      const job = await coletar();

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/593/);
    });

    /** Job inserido por fora da API, sem CNPJ, não pode travar o worker. */
    it('job de coleta sem CNPJ não é tomado pelo worker', async () => {
      const { rows } = await pool.query<{ id: string }>(
        "insert into jobs (tenant_id, kind) values ($1::uuid, 'dfe_sync') returning id",
        [tenantId],
      );
      for (let i = 0; i < 20 && (await app.dfeSync!.runNext()) !== null; i += 1);

      const { rows: depois } = await pool.query('select status from jobs where id = $1::uuid', [rows[0]!.id]);
      expect(depois[0].status).toBe('queued');
    });
  });
});
