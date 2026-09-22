import type pg from 'pg';
import { Logger } from '../../esaa/shared/infrastructure/logger.js';

/**
 * Impede que um erro de cliente ocioso derrube o processo.
 *
 * `pg.Pool` emite `'error'` quando um cliente **ocioso** falha — o banco
 * reiniciou, o pooler encerrou a conexão, houve failover. É um `EventEmitter`:
 * sem listener, Node trata como exceção não capturada e mata o processo.
 *
 * Nenhum pool deste projeto tinha listener, e isso apareceu primeiro no CI como
 * `57P01 terminating connection due to administrator command` derrubando uma
 * suíte em que todos os 971 testes passaram. O caso sério, porém, é o da API:
 * o Supabase encerra conexão ociosa como operação normal, e sem listener isso
 * derruba o servidor inteiro — uma queda de disponibilidade causada por um
 * evento rotineiro do banco.
 *
 * Engolir o erro é correto aqui, e não uma omissão: **falha de query já é
 * tratada** em cada chamada, com o `catch` que a classifica. O que chega neste
 * listener é o cliente ocioso, que não tem requisição associada e cuja
 * reconexão o próprio pool faz na próxima query. O que não pode acontecer é o
 * processo morrer por causa dele.
 */
export function ignorarErroDeClienteOcioso(pool: pg.Pool, contexto: string): void {
  const logger = new Logger(contexto);

  pool.on('error', (erro: Error) => {
    logger.warn('Cliente ocioso do Postgres falhou; o pool reconecta na próxima query.', {
      erro: erro.message,
      // `code` do Postgres quando houver: 57P01 é encerramento administrativo.
      codigo: (erro as NodeJS.ErrnoException).code,
    });
  });
}
