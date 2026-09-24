/**
 * Erro de entrada da superfície pública.
 *
 * As rotas fiscais rejeitam com `ValidationError`, que carrega a camada do
 * pipeline e o motivo tipado — é informação valiosa para o contador, que precisa
 * saber *onde* o documento falhou.
 *
 * Na superfície pública isso não se aplica. Um visitante anônimo que digitou o
 * e-mail errado numa landing page recebia
 * `Validation failed at layer 1: schema_violation - E-mail inválido.`, porque a
 * mensagem do `ValidationError` embute o vocabulário do pipeline. Sete camadas e
 * `schema_violation` não significam nada para quem nunca ouviu falar do produto,
 * e a tela mostra a mensagem da API literalmente.
 *
 * Aqui o erro é de formulário: `400` com a frase que a pessoa precisa ler.
 */
export class PublicInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicInputError';
  }
}
