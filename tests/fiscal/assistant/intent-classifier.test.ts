import { describe, it, expect } from 'vitest';
import { computeCheckDigit } from '../../../src/fiscal/ingestion/access-key.js';
import { digitosVerificadoresDeCnpj } from '../../../src/esaa/shared/domain/cnpj.js';
import {
  classify,
  PERGUNTAS_SUPORTADAS,
  type Intent,
} from '../../../src/fiscal/assistant/intent-classifier.js';

const CHAVE = '35270912345678000195550010000000011234567893';

const intencao = (pergunta: string): Intent => classify(pergunta).intent;

describe('classificação da pergunta', () => {
  describe('intenções reconhecidas', () => {
    it.each([
      ['Quanto devo de ICMS?', 'valor_devido'],
      ['qual o valor devido da competência?', 'valor_devido'],
      ['Em que pé está a competência?', 'estado_da_competencia'],
      ['posso confirmar o mês?', 'estado_da_competencia'],
      ['o que falta para fechar?', 'estado_da_competencia'],
      ['Onde o Fisco discorda da gente?', 'divergencias_do_fisco'],
      ['tem divergência na contra-apuração?', 'divergencias_do_fisco'],
      ['quais itens estão mal classificados?', 'saude_do_cadastro'],
      ['tem problema de NCM no cadastro?', 'saude_do_cadastro'],
      ['o que vence essa semana?', 'prazos_e_pendencias'],
      ['tem alguma pendência atrasada?', 'prazos_e_pendencias'],
      ['quantas notas entraram?', 'documentos_do_periodo'],
      ['quantos documentos entraram no mês?', 'documentos_do_periodo'],
    ] as const)('%s → %s', (pergunta, esperada) => {
      expect(intencao(pergunta)).toBe(esperada);
    });
  });

  /**
   * "Por que o devido está nulo" contém "devido". Responder o valor a quem
   * perguntou o motivo seria responder outra pergunta — com confiança.
   */
  it('distingue o motivo do valor, embora as duas frases compartilhem termos', () => {
    expect(intencao('por que o valor devido está nulo?')).toBe('por_que_nao_determinavel');
    expect(intencao('qual o valor devido?')).toBe('valor_devido');
  });

  it.each([
    'por que não foi calculado o CBS?',
    'o devido saiu como não determinável, por quê?',
  ])('reconhece o pedido de motivo em "%s"', (pergunta) => {
    expect(intencao(pergunta)).toBe('por_que_nao_determinavel');
  });

  describe('intenção desconhecida', () => {
    /**
     * O padrão honesto. Adivinhar faria o assistente responder com confiança a
     * uma pergunta que não foi feita, e no contexto fiscal isso é pior do que
     * não responder.
     */
    it.each([
      'qual a capital da França?',
      'me ajuda a escolher um contador',
      'oi',
      '',
    ])('não adivinha em "%s"', (pergunta) => {
      expect(intencao(pergunta)).toBe('desconhecido');
    });

    it('a lista de perguntas suportadas cobre toda intenção conhecida', () => {
      const conhecidas = new Set(Object.keys(PERGUNTAS_SUPORTADAS));

      for (const pergunta of [
        'quanto devo?',
        'em que pé está?',
        'por que não determinável?',
        'onde o fisco discorda?',
        'itens mal classificados?',
        'quantas notas entraram?',
        'o que aconteceu com a nota?',
        'o que vence?',
      ]) {
        expect(conhecidas).toContain(intencao(pergunta));
      }
    });
  });

  describe('extração de competência', () => {
    it.each([
      ['e em 2027-09?', '2027-09'],
      ['e em 09/2027?', '2027-09'],
      ['e em 9/2027?', '2027-09'],
      ['quanto devo em setembro de 2027?', '2027-09'],
      ['quanto devo em Março de 2027?', '2027-03'],
    ] as const)('%s → %s', (pergunta, esperada) => {
      expect(classify(pergunta).period).toBe(esperada);
    });

    /** Assumir o ano corrente responderia sobre um mês que ninguém pediu. */
    it('mês sem ano não vira competência', () => {
      expect(classify('quanto devo em setembro?').period).toBeUndefined();
    });

    it('não confunde mês 13 com competência', () => {
      expect(classify('quanto devo em 2027-13?').period).toBeUndefined();
    });

    it('a competência é extraída mesmo quando a intenção é desconhecida', () => {
      const r = classify('blá blá 2027-09 blá');

      expect(r.intent).toBe('desconhecido');
      expect(r.period).toBe('2027-09');
    });
  });

  describe('extração de chave de acesso', () => {
    it('reconhece a chave crua', () => {
      const r = classify(`o que aconteceu com ${CHAVE}?`);

      expect(r.intent).toBe('historico_do_documento');
      expect(r.accessKey).toBe(CHAVE);
    });

    it('reconhece a chave com máscara de espaços e pontos', () => {
      const mascarada = CHAVE.replace(/(.{4})/g, '$1 ').trim();

      expect(classify(`histórico de ${mascarada}`).accessKey).toBe(CHAVE);
    });

    /**
     * Só existe uma coisa a dizer sobre um documento específico, então a chave
     * sozinha basta como sinal.
     */
    it('a chave sozinha decide a intenção sem nenhum termo', () => {
      const r = classify(CHAVE);

      expect(r.intent).toBe('historico_do_documento');
      expect(r.matched).toEqual(['chave de acesso']);
    });

    it('número de 43 dígitos não é chave de acesso', () => {
      expect(classify(`e sobre ${CHAVE.slice(0, 43)}?`).accessKey).toBeUndefined();
    });

    describe('chave com CNPJ alfanumérico', () => {
      // Emitente 12ABC345DE01 + DV; chave montada com o DV da NT 2025.001.
      const base43 = '352711' + '12ABC345DE01' + digitosVerificadoresDeCnpj('12ABC345DE01') + '55001000000015123456789';
      const ALFA = base43 + computeCheckDigit(base43);

      it('reconhece a chave crua', () => {
        expect(classify(`o que aconteceu com ${ALFA}?`)).toMatchObject({
          intent: 'historico_do_documento',
          accessKey: ALFA,
        });
      });

      /** Em grupos de 4, um grupo termina em letra e o seguinte começa em dígito. */
      it('reconhece a chave digitada em grupos, e em minúsculas', () => {
        const mascarada = ALFA.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
        expect(classify(`histórico de ${mascarada}`).accessKey).toBe(ALFA);
      });

      it('não cola a palavra anterior na chave', () => {
        expect(classify(`com ${ALFA}`).accessKey).toBe(ALFA);
      });

      /** Com letras, é o dígito verificador que separa a chave do texto em volta. */
      it('com o dígito verificador errado, não é chave', () => {
        const errada = ALFA.slice(0, 43) + String((Number(ALFA[43]) + 1) % 10);
        expect(classify(`o que aconteceu com ${errada}?`).accessKey).toBeUndefined();
      });
    });
  });

  describe('extração de tributo', () => {
    it.each([
      ['quanto devo de ICMS?', 'icms'],
      ['e o CBS?', 'cbs'],
      ['quanto de cofins?', 'cofins'],
    ] as const)('%s → %s', (pergunta, esperado) => {
      expect(classify(pergunta).tax).toBe(esperado);
    });

    it('não inventa tributo quando nenhum é mencionado', () => {
      expect(classify('quanto devo?').tax).toBeUndefined();
    });
  });

  it('devolve os termos que decidiram, para a tela mostrar o porquê', () => {
    const r = classify('onde o Fisco discorda? tem divergência?');

    expect(r.matched).toContain('fisco');
    expect(r.matched.length).toBeGreaterThan(1);
  });

  it('ignora acento e caixa na pergunta', () => {
    expect(intencao('QUAL O VALOR DEVIDO?')).toBe('valor_devido');
    expect(intencao('em que pe esta a competencia?')).toBe('estado_da_competencia');
  });
});
