import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SignJWT } from 'jose';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createClient, createMembership, createTenant, randomCnpj } from '../helpers/db.js';
import { computeCheckDigit } from '../../src/fiscal/ingestion/access-key.js';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const JWT_SECRET = 'segredo-de-teste-que-nao-vai-para-producao';
const AUDIENCE = 'authenticated';
const PERIODO = '2027-11';

function accessKey(issuer: string, numero: string): string {
  const base = '35' + '2711' + issuer + '55' + '001' + numero + '1' + '23456789';
  return base + computeCheckDigit(base);
}

function nfeXml(issuer: string, recipient: string, numero: string): string {
  const key = accessKey(issuer, numero);

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
  <ide><serie>001</serie><nNF>15</nNF><dhEmi>2027-11-15T10:30:00-03:00</dhEmi></ide>
  <emit><CNPJ>${issuer}</CNPJ><xNome>EMITENTE</xNome></emit>
  <dest><CNPJ>${recipient}</CNPJ><xNome>DESTINATARIO</xNome></dest>
  <det nItem="1">
    <prod><cProd>SKU-1</cProd><xProd>Produto</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
      <uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1000.00</vUnCom><vProd>1000.00</vProd></prod>
    <imposto>
      <ICMS><ICMS00><CST>00</CST><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00></ICMS>
    </imposto>
  </det>
  <total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

interface Claim {
  kind: string;
  text: string;
  citations: { kind: string; eventSeq?: number; period?: string; itemId?: string }[];
}

interface Answer {
  intent: string;
  tier: number;
  confidence: string;
  answerable: boolean;
  claims: Claim[];
  suggested: { action: string; method: string; endpoint: string; rationale: string }[];
  unanswerableReason?: string;
}

describe.skipIf(!DATABASE_URL)('API — assistente fiscal somente leitura', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let owner: string;
  let cnpj: string;
  let fornecedor: string;
  let thread: string;

  const tokenFor = async (userId: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
    userId?: string,
  ): Promise<import('light-my-request').Response> => {
    const options: import('light-my-request').InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${await tokenFor(userId ?? owner)}` },
    };
    if (payload !== undefined) options.payload = payload;
    return app.inject(options);
  };

  const subir = async (xmls: string[]): Promise<void> => {
    const form = new FormData();
    xmls.forEach((xml, i) =>
      form.append('files', Buffer.from(xml, 'utf8'), { filename: `n${i}.xml` }),
    );
    const r = await app.inject({
      method: 'POST',
      url: `/v1/clients/${cnpj}/documents`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${await tokenFor(owner)}` },
      payload: form,
    });
    const body = r.json();
    if (body.rejected.length > 0) {
      throw new Error(`ingestão rejeitou: ${JSON.stringify(body.rejected)}`);
    }
  };

  const perguntar = async (question: string): Promise<Answer> => {
    const r = await call('POST', `/v1/clients/${cnpj}/assistant/threads/${thread}/messages`, {
      question,
    });
    if (r.statusCode !== 201) {
      throw new Error(`pergunta "${question}" falhou ${r.statusCode}: ${r.body.slice(0, 400)}`);
    }
    return r.json().answer;
  };

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
    app = await buildServer({ env, pool });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    tenantId = await createTenant(pool, 'Escritório do Assistente');
    owner = await createMembership(pool, tenantId, 'owner');
    cnpj = randomCnpj();
    fornecedor = randomCnpj();

    // `lucro_real` dá a maior cota e isola de `tax_rules`, que outros arquivos
    // apagam em paralelo — aqui nenhuma resposta depende de regra publicada.
    await createClient(pool, tenantId, cnpj, { regime: 'lucro_real' });
    await call('POST', `/v1/clients/${cnpj}/periods`, { period: PERIODO });

    thread = (
      await call('POST', `/v1/clients/${cnpj}/assistant/threads`, { title: 'Fechamento' })
    ).json().id;
  });

  describe('capacidades e cota', () => {
    it('declara o que sabe responder sem exigir CNPJ', async () => {
      const r = await call('GET', '/v1/assistant/capabilities');

      expect(r.statusCode).toBe(200);
      expect(r.json().supported.length).toBeGreaterThanOrEqual(8);
      expect(r.json().language_model_configured).toBe(false);
      expect(r.json().deterministic_only).toBe(true);
    });

    it('a cota vem do plano do regime do cliente', async () => {
      const r = await call('GET', `/v1/clients/${cnpj}/assistant/usage`);

      expect(r.json().allowance).toBe(1000);
      expect(r.json().used).toBe(0);
    });

    /**
     * Fora do plano é 403, não 429: o primeiro é "não contratado" e o segundo é
     * "acabou o mês". Iguais, mandariam o usuário esperar o mês virar por um
     * recurso que ele nunca teria.
     */
    it('regime sem assistente no plano recebe 403, não 429', async () => {
      const mei = randomCnpj();
      await createClient(pool, tenantId, mei, { regime: 'mei' });

      const r = await call('POST', `/v1/clients/${mei}/assistant/threads`, { title: 'x' });

      expect(r.statusCode).toBe(403);
      expect(r.json().message).toMatch(/não está incluído no plano/);
    });

    /**
     * `plans` é tabela global e os arquivos de teste rodam em paralelo, então a
     * cota é baixada e **restaurada**: deixá-la em 1 faria qualquer outro
     * arquivo que use o mesmo regime receber 429 sem explicação.
     */
    it('cota esgotada recebe 429 com usado e limite no corpo', async () => {
      const { rows } = await pool.query<{ valor: number }>(
        `select assistant_messages_per_month as valor from plans where regime = 'lucro_presumido'`,
      );
      const original = rows[0]!.valor;

      try {
        await pool.query(
          `update plans set assistant_messages_per_month = 1 where regime = 'lucro_presumido'`,
        );
        const limitado = randomCnpj();
        await createClient(pool, tenantId, limitado, { regime: 'lucro_presumido' });
        const t = (
          await call('POST', `/v1/clients/${limitado}/assistant/threads`, { title: 'x' })
        ).json().id;

        const rota = `/v1/clients/${limitado}/assistant/threads/${t}/messages`;
        await call('POST', rota, { question: 'quanto devo?' });
        const segunda = await call('POST', rota, { question: 'quanto devo?' });

        expect(segunda.statusCode).toBe(429);
        expect(segunda.json().usage.allowance).toBe(1);
        expect(segunda.json().usage.used).toBe(1);
      } finally {
        await pool.query(
          `update plans set assistant_messages_per_month = $1 where regime = 'lucro_presumido'`,
          [original],
        );
      }
    });

    it('a pergunta consome a cota e o cabeçalho devolve o que resta', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assistant/threads/${thread}/messages`, {
        question: 'quanto devo?',
      });

      expect(r.headers['x-assistant-remaining']).toBe('999');
      expect((await call('GET', `/v1/clients/${cnpj}/assistant/usage`)).json().used).toBe(1);
    });
  });

  describe('governança — o assistente não escreve no log fiscal', () => {
    /**
     * A propriedade central da onda. O serviço não recebe orquestrador, então
     * não existe caminho de código daqui até o log — a checagem abaixo é a
     * verificação empírica disso.
     */
    it('uma conversa inteira não acrescenta um único evento ao log', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      const antes = await pool.query<{ total: string }>(
        'select count(*)::text as total from events where tenant_id = $1::uuid and cnpj = $2::char(14)',
        [tenantId, cnpj],
      );

      for (const pergunta of [
        'quanto devo?',
        'em que pé está a competência?',
        'onde o fisco discorda?',
        'quais itens estão mal classificados?',
        'o que vence?',
        'quantas notas entraram?',
        'por que o devido está nulo?',
        'qual a capital da França?',
      ]) {
        await perguntar(pergunta);
      }

      const depois = await pool.query<{ total: string }>(
        'select count(*)::text as total from events where tenant_id = $1::uuid and cnpj = $2::char(14)',
        [tenantId, cnpj],
      );

      expect(depois.rows[0]!.total).toBe(antes.rows[0]!.total);
    });

    /** Ler o calendário não pode materializar prazo: seria escrita numa leitura. */
    it('perguntar por prazos não cria linha em deadlines', async () => {
      await perguntar('o que vence?');

      const { rows } = await pool.query<{ total: string }>(
        'select count(*)::text as total from deadlines where tenant_id = $1::uuid',
        [tenantId],
      );

      expect(rows[0]!.total).toBe('0');
    });

    it('ação recomendada vem com rota e motivo, e não é executada', async () => {
      const answer = await perguntar('em que pé está a competência?');

      expect(answer.suggested[0]!.method).toBe('POST');
      expect(answer.suggested[0]!.endpoint).toContain(`/assessments/${PERIODO}`);
      expect(answer.suggested[0]!.rationale).toBeTruthy();

      // A sugestão de apurar não apurou nada.
      const apuracao = await call('GET', `/v1/clients/${cnpj}/assessments/${PERIODO}`);
      expect(apuracao.statusCode).toBe(404);
    });
  });

  describe('ancoragem — toda afirmação factual cita evidência', () => {
    it('cada afirmação factual de toda resposta carrega ao menos uma citação', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      for (const pergunta of [
        'quanto devo?',
        'em que pé está a competência?',
        'quantas notas entraram?',
        'por que o devido está nulo?',
      ]) {
        const answer = await perguntar(pergunta);
        const fatos = answer.claims.filter((c) => c.kind === 'fact');

        expect(fatos.length).toBeGreaterThan(0);
        for (const afirmacao of fatos) {
          expect(afirmacao.citations.length).toBeGreaterThan(0);
        }
      }
    });

    it('o histórico da nota cita o event_seq de cada evento', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      const chave = accessKey(cnpj, '000000015');

      const answer = await perguntar(`o que aconteceu com ${chave}?`);

      expect(answer.intent).toBe('historico_do_documento');
      const citacoes = answer.claims.flatMap((c) => c.citations);
      expect(citacoes.some((c) => c.kind === 'event' && typeof c.eventSeq === 'number')).toBe(
        true,
      );
    });

    /** O event_seq citado tem de existir de verdade no log deste CNPJ. */
    it('o event_seq citado existe no log e é conferível', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      const chave = accessKey(cnpj, '000000015');

      const answer = await perguntar(`histórico de ${chave}`);
      const seqs = answer.claims
        .flatMap((c) => c.citations)
        .filter((c) => c.kind === 'event')
        .map((c) => c.eventSeq!);

      const { rows } = await pool.query<{ total: string }>(
        `select count(*)::text as total from events
          where tenant_id = $1::uuid and cnpj = $2::char(14) and event_seq = any($3::bigint[])`,
        [tenantId, cnpj, seqs],
      );

      expect(seqs.length).toBeGreaterThan(0);
      expect(Number(rows[0]!.total)).toBe(seqs.length);
    });
  });

  describe('honestidade das respostas', () => {
    /**
     * O contraexemplo do briefing: assistente genérico sem ancoragem compete com
     * o ChatGPT e perde. Aqui ele diz o que não sabe.
     */
    it('pergunta fora do escopo recebe "não sei" com a lista do que sabe', async () => {
      const answer = await perguntar('qual a capital da França?');

      expect(answer.answerable).toBe(false);
      expect(answer.intent).toBe('desconhecido');
      expect(answer.claims).toHaveLength(0);
      expect(answer.unanswerableReason).toMatch(/Sei responder/);
      expect(answer.unanswerableReason).toMatch(/não há modelo de linguagem configurado/);
    });

    it('a intenção desconhecida é roteada para a camada 3, não fingida na 1', async () => {
      expect((await perguntar('me conta uma piada')).tier).toBe(3);
      expect((await perguntar('quantas notas entraram?')).tier).toBe(1);
    });

    it('competência não apurada não recebe valor inventado', async () => {
      const answer = await perguntar('quanto devo?');

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/não foi apurada/);
      expect(answer.suggested[0]!.action).toBe('assessment.projected');
    });

    /**
     * Devido nulo é resposta certa e incompleta. Confiança alta faria o contador
     * tratá-la como fechada.
     */
    it('devido não determinável baixa a confiança e explica o motivo', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      const answer = await perguntar('quanto devo de ICMS?');

      expect(answer.answerable).toBe(true);
      expect(answer.confidence).toBe('medium');
      expect(answer.claims.some((c) => c.text.includes('não determinável'))).toBe(true);
      expect(
        answer.claims.some(
          (c) => c.kind === 'explanation' && c.text.includes('pior do que um ausente'),
        ),
      ).toBe(true);
    });

    it('distingue o pedido de motivo do pedido de valor', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      expect((await perguntar('por que o devido está nulo?')).intent).toBe(
        'por_que_nao_determinavel',
      );
      expect((await perguntar('qual o valor devido?')).intent).toBe('valor_devido');
    });

    it('sem proposta do Fisco, diz que não há com o que comparar', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);

      const answer = await perguntar('onde o fisco discorda?');

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/Nenhuma proposta do Fisco/);
      expect(answer.suggested[0]!.action).toBe('assessment.compared');
    });

    it('cadastro sem inconsistência não é confundido com cadastro conferido', async () => {
      const answer = await perguntar('quais itens estão mal classificados?');

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/não é o mesmo que estar correto/);
    });

    it('a explicação da divergência diz que a causa é hipótese', async () => {
      await subir([nfeXml(cnpj, fornecedor, '000000015')]);
      await call('POST', `/v1/clients/${cnpj}/assessments/${PERIODO}`);
      const chave = accessKey(cnpj, '000000015');

      await app.inject({
        method: 'POST',
        url: `/v1/clients/${cnpj}/fisco-assessments/${PERIODO}`,
        headers: {
          authorization: `Bearer ${await tokenFor(owner)}`,
          'content-type': 'text/csv',
        },
        payload: `chave_acesso;item;tributo;sentido;base;aliquota;valor\n${chave};1;icms;S;1000,00;12;120,00`,
      });

      const answer = await perguntar('onde o fisco discorda?');

      expect(answer.answerable).toBe(true);
      expect(
        answer.claims.some((c) => c.kind === 'explanation' && c.text.includes('hipótese')),
      ).toBe(true);
      expect(answer.claims.some((c) => c.text.includes('aliquota_divergente'))).toBe(true);
    });

    it('nota inexistente no log não recebe histórico inventado', async () => {
      const answer = await perguntar(`o que aconteceu com ${accessKey(cnpj, '000000999')}?`);

      expect(answer.answerable).toBe(false);
      expect(answer.unanswerableReason).toMatch(/Nenhum evento no log/);
    });
  });

  describe('conversas', () => {
    it('grava pergunta e resposta na ordem, com a intenção na resposta', async () => {
      await perguntar('quantas notas entraram?');

      const { messages } = (
        await call(
          'GET',
          `/v1/clients/${cnpj}/assistant/threads/${thread}/messages`,
        )
      ).json();

      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe('user');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[1]!.intent).toBe('documentos_do_periodo');
      expect(messages[1]!.claims.length).toBeGreaterThanOrEqual(0);
    });

    it('a conversa de outro escritório não é acessível', async () => {
      const outro = await createTenant(pool, 'Escritório vizinho');
      const intruso = await createMembership(pool, outro, 'owner');
      await createClient(pool, outro, cnpj, { regime: 'lucro_real' });

      const r = await call(
        'GET',
        `/v1/clients/${cnpj}/assistant/threads/${thread}/messages`,
        undefined,
        intruso,
      );

      expect(r.statusCode).toBe(404);
    });

    it('conversa inexistente é 404', async () => {
      const r = await call(
        'POST',
        `/v1/clients/${cnpj}/assistant/threads/00000000-0000-0000-0000-000000000000/messages`,
        { question: 'quanto devo?' },
      );

      expect(r.statusCode).toBe(404);
    });

    it('pergunta vazia é recusada na validação de schema', async () => {
      const r = await call('POST', `/v1/clients/${cnpj}/assistant/threads/${thread}/messages`, {
        question: '',
      });

      expect(r.statusCode).toBe(400);
    });

    it('lista as conversas do CNPJ com a contagem de mensagens', async () => {
      await perguntar('quantas notas entraram?');

      const r = await call('GET', `/v1/clients/${cnpj}/assistant/threads`);

      expect(r.json().total).toBe(1);
      expect(r.json().threads[0]!.messages_count).toBe(2);
    });
  });
});
