/**
 * Trilha de segurança: quem tentou entrar, quem foi barrado, quem levou limite.
 *
 * O event log responde "quem mudou este número fiscal" e é prova perante o
 * Fisco. Não responde as perguntas de um incidente — tentativa de login,
 * recusa por papel, rajada de um mesmo lugar. Essas linhas existiam só na saída
 * padrão, que o provedor guarda por pouco tempo, então uma apuração de seis
 * meses atrás não tinha material.
 *
 * Três decisões que valem o registro:
 *
 * **Nunca derruba a requisição.** Gravar auditoria é importante; recusar
 * atender porque a auditoria falhou seria pior. A falha vai para o log de
 * aplicação em nível de erro — perder a linha em silêncio é que não pode.
 *
 * **Guarda HMAC do IP, nunca o IP.** Liga tentativas entre si sem guardar dado
 * pessoal. O domínio do HMAC é próprio, então este hash não é comparável com o
 * do diagnóstico público: cruzar os dois passa a ser decisão, e não efeito
 * colateral de terem usado a mesma chave.
 *
 * **Tem freio.** Sem ele, um laço batendo em rota autenticada com token
 * inválido escreveria uma linha por requisição — a trilha de segurança viraria
 * o vetor. O freio é por tipo e por origem, e o que ele descarta continua no
 * log de aplicação.
 */
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { createBurstLimiter } from '../../api/plugins/rate-limit.js';

export type SecurityEventKind =
  | 'login_ok'
  | 'login_falhou'
  | 'nao_autenticado'
  | 'sem_permissao'
  | 'limite';

export interface SecurityEvent {
  kind: SecurityEventKind;
  userId?: string | undefined;
  tenantId?: string | undefined;
  cnpj?: string | undefined;
  method?: string | undefined;
  route?: string | undefined;
  ip?: string | undefined;
  /** E-mail tentado. É guardado como HMAC, nunca em claro. */
  subject?: string | undefined;
  userAgent?: string | undefined;
  detail?: string | undefined;
}

export interface SecurityTrail {
  registrar(evento: SecurityEvent): void;
}

/**
 * Teto por tipo e origem. Generoso para não perder o começo de um ataque, e
 * baixo o bastante para que o ataque não vire carga de escrita.
 */
const FREIO = { windowMs: 60_000, max: 30 };

/** Só os primeiros 200 caracteres: user-agent é campo livre e pode vir enorme. */
const LIMITE_DE_TEXTO = 200;

export function criarTrilhaDeSeguranca(
  pool: Pool,
  segredoDoHash: string,
  aoFalhar: (mensagem: string, dados: Record<string, unknown>) => void,
): SecurityTrail {
  const freio = createBurstLimiter(FREIO);

  return {
    registrar(evento: SecurityEvent): void {
      const ipHash = evento.ip === undefined ? null : hashDoIp(evento.ip, segredoDoHash);

      // A chave do freio inclui o tipo: uma rajada de `nao_autenticado` não pode
      // esconder um `sem_permissao` acontecendo ao mesmo tempo.
      if (!freio.hit(`${evento.kind}:${ipHash ?? evento.userId ?? 'anonimo'}`).allowed) {
        return;
      }

      void pool
        .query(
          `insert into security_events
             (kind, user_id, tenant_id, cnpj, method, route, ip_hash, subject_hash,
            user_agent, detail)
           values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)`,
          [
            evento.kind,
            evento.userId ?? null,
            evento.tenantId ?? null,
            evento.cnpj ?? null,
            evento.method ?? null,
            cortar(evento.route),
            ipHash,
            evento.subject === undefined
              ? null
              : hmac(`security-trail-subject:${evento.subject.trim().toLowerCase()}`, segredoDoHash),
            cortar(evento.userAgent),
            cortar(evento.detail),
          ],
        )
        .catch((causa: unknown) => {
          aoFalhar('Não foi possível gravar na trilha de segurança.', {
            kind: evento.kind,
            erro: causa instanceof Error ? causa.message : String(causa),
          });
        });
    },
  };
}

function cortar(valor: string | undefined): string | null {
  if (valor === undefined) {
    return null;
  }
  return valor.length > LIMITE_DE_TEXTO ? valor.slice(0, LIMITE_DE_TEXTO) : valor;
}

/** Domínio próprio: não é comparável com o hash do diagnóstico público. */
function hashDoIp(ip: string, segredo: string): string {
  return hmac(`security-trail-ip:${ip}`, segredo);
}

function hmac(entrada: string, segredo: string): string {
  return createHmac('sha256', segredo).update(entrada).digest('hex');
}
