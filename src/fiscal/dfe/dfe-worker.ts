import type { DfeSyncService } from './dfe-sync.service.js';

export interface DfeWorker {
  stop(): Promise<void>;
}

/**
 * Consumidor da fila de coleta, no próprio processo da API (ADR-006).
 *
 * Um tique esvazia a fila, até um teto por tique, e dorme. Mais de uma
 * instância pode rodar: o `for update skip locked` de `runNext` garante que um
 * job não é tomado duas vezes. Erro de um tique não derruba o worker, porque o
 * job que falhou já foi marcado `failed` pelo serviço.
 */
export function startDfeWorker(
  service: DfeSyncService,
  options: { intervalMs?: number; maxPorTique?: number; onError?: (erro: unknown) => void } = {},
): DfeWorker {
  const intervalo = options.intervalMs ?? 15_000;
  const teto = options.maxPorTique ?? 5;
  let parar = false;
  let emCurso: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const tique = async (): Promise<void> => {
    for (let i = 0; i < teto && !parar; i += 1) {
      if ((await service.runNext()) === null) break;
    }
  };

  const agendar = (): void => {
    if (parar) return;
    timer = setTimeout(() => {
      emCurso = tique()
        .catch((erro) => options.onError?.(erro))
        .finally(agendar);
    }, intervalo);
    // Não segura o processo vivo sozinho: o `serve` encerra quando o servidor fecha.
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

/** Dez minutos: a SEFAZ bloqueia por uma hora depois de alcançada a fila, e o agendador só pede o que venceu. */
const INTERVALO_DO_AGENDADOR = 600_000;

/**
 * Agendador da coleta com opt-in (ADR-007). A cada tique enfileira a coleta de
 * todo CNPJ com a opção ligada que pode coletar agora; quem executa é o worker.
 * Duas instâncias não duplicam job: `enqueue` devolve o pendente.
 */
export function startDfeScheduler(
  service: Pick<DfeSyncService, 'scheduleDue'>,
  options: { intervalMs?: number; onError?: (erro: unknown) => void } = {},
): DfeWorker {
  const intervalo = options.intervalMs ?? INTERVALO_DO_AGENDADOR;
  let parar = false;
  let emCurso: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const agendar = (): void => {
    if (parar) return;
    timer = setTimeout(() => {
      emCurso = service
        .scheduleDue()
        .then(() => undefined)
        .catch((erro) => options.onError?.(erro))
        .finally(agendar);
    }, intervalo);
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
