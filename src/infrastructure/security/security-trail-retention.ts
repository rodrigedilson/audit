/**
 * Expurgo da trilha de segurança.
 *
 * Trilha sem prazo de descarte não é zelo, é acúmulo. A tabela cresce sem fim e
 * passa a guardar por tempo indeterminado o rastro de quem tentou entrar — que é
 * dado pessoal, ainda que em HMAC. Guardar para sempre "por via das dúvidas" é o
 * que a LGPD chama de tratamento sem finalidade.
 *
 * **Cento e oitenta dias**, que é o horizonte descrito na própria lacuna: "uma
 * investigação de seis meses atrás não teria material". Menos derrota o motivo
 * de a trilha existir; muito mais exigiria justificar por quê, e não há
 * justificativa à mão.
 *
 * Apaga em lotes. Um `delete` único sobre meses de trilha seguraria a tabela por
 * tempo indefinido, e a trilha é escrita no caminho de **toda recusa** — travá-la
 * travaria as respostas de erro da API.
 */
import type { Pool } from 'pg';

export const RETENCAO_EM_DIAS = 180;

/** Linhas por lote, para a transação ser curta. */
const LOTE = 5_000;

/** Teto de lotes por execução: acúmulo grande não vira varredura sem fim. */
const MAX_LOTES = 50;

export async function expurgarTrilhaDeSeguranca(
  pool: Pool,
  dias: number = RETENCAO_EM_DIAS,
): Promise<number> {
  let apagadas = 0;

  for (let i = 0; i < MAX_LOTES; i += 1) {
    const { rowCount } = await pool.query(
      `delete from security_events
        where id in (
          select id from security_events
           where at < now() - ($1 || ' days')::interval
           order by id
           limit $2
        )`,
      [String(dias), LOTE],
    );

    apagadas += rowCount ?? 0;
    if ((rowCount ?? 0) < LOTE) {
      break;
    }
  }

  return apagadas;
}

export interface TrailPruner {
  stop(): Promise<void>;
}

/** Uma vez por dia basta: o que se apaga já passou de 180 dias. */
const INTERVALO = 24 * 60 * 60 * 1000;

/**
 * Roda no próprio processo da API, como o agendador da coleta de DF-e.
 *
 * Com mais de uma instância, todas expurgam, e não há problema: apagar o que já
 * venceu é idempotente, e a segunda encontra menos linhas que a primeira.
 */
export function startSecurityTrailPruner(
  pool: Pool,
  options: {
    intervalMs?: number;
    dias?: number;
    onError?: (erro: unknown) => void;
    onPurge?: (apagadas: number) => void;
  } = {},
): TrailPruner {
  const intervalo = options.intervalMs ?? INTERVALO;
  let parar = false;
  let emCurso: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const agendar = (): void => {
    if (parar) return;
    timer = setTimeout(() => {
      emCurso = expurgarTrilhaDeSeguranca(pool, options.dias)
        .then((apagadas) => {
          if (apagadas > 0) {
            options.onPurge?.(apagadas);
          }
        })
        .catch((erro) => options.onError?.(erro))
        .finally(agendar);
    }, intervalo);
    // Não segura o processo vivo sozinho.
    timer.unref();
  };

  agendar();

  return {
    async stop() {
      parar = true;
      if (timer !== undefined) clearTimeout(timer);
      await emCurso;
    },
  };
}
