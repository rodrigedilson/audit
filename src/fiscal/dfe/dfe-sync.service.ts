import type { Pool } from 'pg';
import { EventScope } from '../../esaa/core/event-store/value-objects/event-scope.vo.js';
import type { FiscalOrchestratorService } from '../../esaa/orchestrator/fiscal-orchestrator.service.js';
import { guardarCompletos, ingerirPendentes } from './dfe-documents.js';
import { CertificateVault, lerCredencial, type CredencialA1 } from '../portfolio/certificate-vault.js';
import {
  CODIGO_UF,
  NSU_ZERO,
  cienciaRegistrada,
  dataHoraBrasilia,
  eventoVinculado,
  lerEventoNfe,
  lerResumoNfe,
  TP_CANCELAMENTO,
  type RespostaDistribuicao,
} from './dfe-xml.js';
import type { SefazDfeGateway } from './sefaz-gateway.js';

/**
 * Coleta de DF-e de um CNPJ (ADR-006): distribuição por NSU até alcançar o
 * `maxNSU`, ingestão das NF-e completas pelo mesmo caminho do upload, e ciência
 * da operação para os resumos de entrada.
 *
 * A fila é a tabela `jobs`: `enqueue` produz, e `runNext` consome com
 * `for update skip locked`.
 */

/** Teto de lotes por execução: cada lote traz até 50 documentos. */
const MAX_LOTES = 20;
/** Teto de ciências por execução, para um job não virar uma rajada de eventos. */
const MAX_CIENCIAS = 50;
/** Uma hora: a pena do 656 e a espera depois de alcançar o `maxNSU`. */
const ESPERA_MS = 3600_000;
/** Job `running` há mais que isto é de um processo que morreu no meio. */
const JOB_ABANDONADO = "interval '15 minutes'";

/** Pedido recusado antes de enfileirar — 409 ou 429 na API. */
export class DfeSyncRefusedError extends Error {
  constructor(
    message: string,
    readonly kind: 'no_certificate' | 'certificate_not_usable' | 'missing_uf' | 'blocked',
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = 'DfeSyncRefusedError';
  }
}

export interface EnqueuedJob {
  jobId: string;
  reused: boolean;
}

interface Job {
  id: string;
  tenant_id: string;
  cnpj: string;
  requested_by: string | null;
}

export interface SyncSummary {
  lotes: number;
  ult_nsu: string;
  max_nsu: string;
  last_cstat: string;
  last_motivo: string;
  full_documents: number;
  rejected_documents: number;
  already_present: number;
  awaiting_period: number;
  summaries: number;
  ciencias: number;
  ciencia_failures: number;
  events_seen: number;
  /** Cancelamentos aplicados: viraram `doc.cancelled` e saíram das somas. */
  cancellations: number;
  /** Cancelamentos de competência confirmada: ficam como pendência de retificação. */
  cancellations_blocked: number;
  blocked_until: string | null;
}

/** Motivo gravado em `dfe_events` quando o cancelamento esbarra no INV-001. */
export const CANCELAMENTO_EXIGE_RETIFICACAO = 'competência confirmada: exige retificação';

export class DfeSyncService {
  private readonly vault: CertificateVault;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: SefazDfeGateway,
    masterKey: string,
    previousKey: string | undefined,
    private readonly orchestratorFor: (scope: EventScope) => Promise<FiscalOrchestratorService>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.vault = new CertificateVault(masterKey, previousKey);
  }

  /**
   * Enfileira a coleta. Recusa, antes de criar job, o que não teria como dar
   * certo: sem certificado, certificado antigo, cliente sem UF, SEFAZ bloqueada.
   * Job pendente do mesmo CNPJ é devolvido em vez de duplicado.
   */
  async enqueue(scope: EventScope, requestedBy: string): Promise<EnqueuedJob> {
    const { rows: certs } = await this.pool.query<{ credential_format: string }>(
      'select credential_format from certificates where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    if (certs.length === 0) {
      throw new DfeSyncRefusedError('Este CNPJ não tem certificado A1 guardado.', 'no_certificate');
    }
    if (certs[0]!.credential_format !== 'pem_bundle') {
      throw new DfeSyncRefusedError(
        'O certificado deste CNPJ foi guardado antes da coleta de DF-e, num formato que não ' +
          'abre sem a senha (que não é guardada). Reenvie o certificado para coletar.',
        'certificate_not_usable',
      );
    }

    const { rows: cliente } = await this.pool.query<{ uf: string | null }>(
      'select uf from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    if (CODIGO_UF[cliente[0]?.uf?.trim().toUpperCase() ?? ''] === undefined) {
      throw new DfeSyncRefusedError(
        'O cadastro do cliente não tem UF. A distribuição exige a UF do autor do pedido.',
        'missing_uf',
      );
    }

    const bloqueio = await this.bloqueadoAte(scope);
    if (bloqueio !== null) {
      throw new DfeSyncRefusedError(
        `A SEFAZ só aceita nova consulta deste CNPJ a partir de ${bloqueio.toISOString()}: ` +
          'consultar antes conta como consumo indevido e bloqueia por uma hora.',
        'blocked',
        bloqueio,
      );
    }

    const { rows: pendente } = await this.pool.query<{ id: string }>(
      `select id from jobs
        where tenant_id = $1::uuid and cnpj = $2::char(14) and kind = 'dfe_sync'
          and status in ('queued', 'running')
        order by created_at limit 1`,
      [scope.tenantId, scope.cnpj],
    );
    if (pendente[0] !== undefined) {
      return { jobId: pendente[0].id, reused: true };
    }

    const { rows } = await this.pool.query<{ id: string }>(
      `insert into jobs (tenant_id, cnpj, kind, requested_by)
       values ($1::uuid, $2::char(14), 'dfe_sync', $3::uuid) returning id`,
      [scope.tenantId, scope.cnpj, requestedBy],
    );
    return { jobId: rows[0]!.id, reused: false };
  }

  /** Toma o próximo job e o executa. `null` quando a fila está vazia. */
  async runNext(): Promise<string | null> {
    const { rows } = await this.pool.query<Job>(
      `update jobs set status = 'running', started_at = now(), progress = 0
        where id = (
          select id from jobs
           where kind = 'dfe_sync'
             -- Coleta sem CNPJ não existe: um job assim, inserido por fora da
             -- API, travaria o worker a cada tique se fosse tomado.
             and cnpj is not null
             and (status = 'queued' or (status = 'running' and started_at < now() - ${JOB_ABANDONADO}))
           order by created_at
           for update skip locked
           limit 1)
        returning id, tenant_id, cnpj, requested_by`,
    );
    const job = rows[0];
    if (job === undefined) {
      return null;
    }

    try {
      const resumo = await this.run(job);
      await this.pool.query(
        `update jobs set status = 'done', progress = 100, accepted = $2, rejected = $3,
                result = $4::jsonb, finished_at = now()
          where id = $1::uuid`,
        [job.id, resumo.full_documents, resumo.rejected_documents, JSON.stringify(resumo)],
      );
    } catch (erro) {
      await this.pool.query(
        `update jobs set status = 'failed', error = $2, finished_at = now() where id = $1::uuid`,
        [job.id, erro instanceof Error ? erro.message : String(erro)],
      );
    }
    return job.id;
  }

  private async run(job: Job): Promise<SyncSummary> {
    const scope = EventScope.create(job.tenant_id, job.cnpj.trim());
    if (job.requested_by === null) {
      throw new Error('Job sem requested_by: não há em nome de quem usar o certificado.');
    }
    const actor = job.requested_by;
    const credencial = await this.credencial(scope);
    const cUFAutor = await this.codigoUf(scope);
    const orchestrator = await this.orchestratorFor(scope);

    const bloqueio = await this.bloqueadoAte(scope);
    if (bloqueio !== null) {
      throw new Error(`SEFAZ bloqueada para este CNPJ até ${bloqueio.toISOString()}.`);
    }

    const resumo: SyncSummary = {
      lotes: 0,
      ult_nsu: await this.ultNsu(scope),
      max_nsu: NSU_ZERO,
      last_cstat: '',
      last_motivo: '',
      full_documents: 0,
      rejected_documents: 0,
      already_present: 0,
      awaiting_period: 0,
      summaries: 0,
      ciencias: 0,
      ciencia_failures: 0,
      events_seen: 0,
      cancellations: 0,
      cancellations_blocked: 0,
      blocked_until: null,
    };

    const completos: { nsu: string; xml: string }[] = [];

    for (let i = 0; i < MAX_LOTES; i += 1) {
      let resposta: RespostaDistribuicao;
      try {
        resposta = await this.gateway.distribuir(credencial, {
          tpAmb: 1,
          cUFAutor,
          cnpj: scope.cnpj,
          ultNsu: resumo.ult_nsu,
        });
      } catch (erro) {
        await this.usoDoCertificado(orchestrator, scope, actor, 'dfe_distribution', 'NFeDistribuicaoDFe', 'failure');
        throw erro;
      }
      await this.usoDoCertificado(orchestrator, scope, actor, 'dfe_distribution', 'NFeDistribuicaoDFe', 'success');

      resumo.lotes += 1;
      resumo.last_cstat = resposta.cStat;
      resumo.last_motivo = resposta.xMotivo;

      if (resposta.cStat === '656') {
        // Consumo indevido: uma hora sem consulta, e nada do lote é confiável.
        resumo.blocked_until = new Date(this.now().getTime() + ESPERA_MS).toISOString();
        break;
      }
      if (resposta.cStat !== '137' && resposta.cStat !== '138') {
        await this.gravarEstado(scope, resumo);
        throw new Error(`SEFAZ recusou a distribuição: ${resposta.cStat} ${resposta.xMotivo}`);
      }

      resumo.ult_nsu = resposta.ultNsu;
      resumo.max_nsu = resposta.maxNsu;

      for (const doc of resposta.documentos) {
        if (doc.esquema === 'procNFe') {
          completos.push({ nsu: doc.nsu, xml: doc.xml });
        } else if (doc.esquema === 'resNFe') {
          await this.guardarResumo(scope, doc.nsu, doc.xml);
          resumo.summaries += 1;
        } else if (doc.esquema === 'resEvento' || doc.esquema === 'procEventoNFe') {
          await this.guardarEvento(scope, doc.nsu, doc.xml);
          resumo.events_seen += 1;
        } else {
          resumo.events_seen += 1;
        }
      }

      // Alcançou a fila (ou não havia nada): pedir de novo antes de uma hora
      // conta como consumo indevido.
      if (resposta.cStat === '137' || resposta.ultNsu >= resposta.maxNsu) {
        resumo.blocked_until = new Date(this.now().getTime() + ESPERA_MS).toISOString();
        break;
      }
    }

    await this.gravarEstado(scope, resumo);

    // Guarda antes de ingerir: a nota de competência fechada espera, e a ciência
    // não é refeita para o que já chegou completo.
    await this.marcarRecebidos(scope, await guardarCompletos(this.pool, scope, completos));
    const ingestao = await ingerirPendentes(this.pool, scope, orchestrator, actor);
    resumo.full_documents = ingestao.ingested;
    resumo.rejected_documents = ingestao.rejected;
    resumo.already_present = ingestao.alreadyPresent;
    resumo.awaiting_period = ingestao.awaitingPeriod;

    // Depois da ingestão: o cancelamento pode ter chegado no mesmo lote da nota,
    // ou antes dela, e só se aplica a nota que já está na base.
    await this.aplicarCancelamentos(scope, orchestrator, actor, resumo);

    await this.manifestar(scope, credencial, orchestrator, actor, resumo);

    return resumo;
  }

  /** Ciência da operação para os resumos que ainda não a têm. */
  private async manifestar(
    scope: EventScope,
    credencial: CredencialA1,
    orchestrator: FiscalOrchestratorService,
    actor: string,
    resumo: SyncSummary,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ access_key: string }>(
      `select access_key from dfe_summaries
        where tenant_id = $1::uuid and cnpj = $2::char(14)
          and manifested_at is null and received_at is null
        order by created_at limit ${MAX_CIENCIAS}`,
      [scope.tenantId, scope.cnpj],
    );

    for (const { access_key } of rows) {
      // Um minuto para trás: dhEvento à frente do relógio da SEFAZ é rejeitado.
      const dhEvento = dataHoraBrasilia(new Date(this.now().getTime() - 60_000));
      let cStat = '';
      let motivo = '';
      try {
        const r = await this.gateway.manifestarCiencia(credencial, {
          tpAmb: 1,
          cnpj: scope.cnpj,
          accessKey: access_key,
          dhEvento,
        });
        cStat = r.cStat;
        motivo = r.xMotivo;
      } catch (erro) {
        motivo = erro instanceof Error ? erro.message : String(erro);
      }

      const ok = cienciaRegistrada(cStat);
      await this.usoDoCertificado(
        orchestrator,
        scope,
        actor,
        'manifestation',
        `NFeRecepcaoEvento4 210210 ${access_key}`,
        ok ? 'success' : 'failure',
      );
      await this.pool.query(
        `update dfe_summaries
            set manifested_at = case when $4 then now() else manifested_at end,
                manifest_cstat = $5, manifest_motivo = $6
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3`,
        [scope.tenantId, scope.cnpj, access_key, ok, cStat || null, motivo || null],
      );
      if (ok) {
        resumo.ciencias += 1;
      } else {
        resumo.ciencia_failures += 1;
      }
    }
  }

  /**
   * Cancelamento homologado de nota que está na base vira `doc.cancelled`, e a
   * nota sai das somas. Competência confirmada não muda (INV-001): o evento fica
   * em `dfe_events` com o motivo, e a correção é a retificação. A checagem é
   * feita antes de propor, para não gravar um `output.rejected` a cada coleta.
   * Cancelamento de nota que ainda não chegou espera a coleta seguinte.
   */
  private async aplicarCancelamentos(
    scope: EventScope,
    orchestrator: FiscalOrchestratorService,
    actor: string,
    resumo: SyncSummary,
  ): Promise<void> {
    const { rows } = await this.pool.query<{
      access_key: string;
      tp_evento: string;
      n_seq_evento: number;
      protocolo: string | null;
      dh_evento: Date | null;
      period: string;
      state: string | null;
    }>(
      `select e.access_key, e.tp_evento, e.n_seq_evento, e.protocolo, e.dh_evento, d.period, p.state
         from dfe_events e
         join documents d
           on d.tenant_id = e.tenant_id and d.cnpj = e.cnpj and d.access_key = e.access_key
         left join periods p
           on p.tenant_id = d.tenant_id and p.cnpj = d.cnpj and p.period = d.period
        where e.tenant_id = $1::uuid and e.cnpj = $2::char(14)
          and e.applied_at is null and e.blocked_reason is null
          and e.tp_evento = any($3::text[])
          and (e.cstat is null or e.cstat in ('135', '155'))
          and d.cancelled_at is null
        order by e.received_at`,
      [scope.tenantId, scope.cnpj, TP_CANCELAMENTO],
    );

    const aplicados = new Set<string>();
    for (const e of rows) {
      const chave = e.access_key.trim();
      // Cancelamento e cancelamento por substituição da mesma nota: um basta.
      if (aplicados.has(chave)) continue;

      if (e.state === 'confirmed') {
        await this.bloquearEvento(scope, e, CANCELAMENTO_EXIGE_RETIFICACAO);
        resumo.cancellations_blocked += 1;
        continue;
      }

      const r = await orchestrator.processIntention({
        action: 'doc.cancelled',
        task_id: chave,
        actor,
        period: e.period,
        payload: {
          access_key: chave,
          tp_evento: e.tp_evento,
          n_seq_evento: e.n_seq_evento,
          protocol: e.protocolo,
          cancelled_at: e.dh_evento === null ? null : e.dh_evento.toISOString(),
        },
      });
      if (!r.accepted) {
        await this.bloquearEvento(scope, e, r.rejectionReason ?? 'recusado pelo pipeline');
        resumo.cancellations_blocked += 1;
        continue;
      }

      await this.pool.query(
        `update documents
            set cancelled_at = coalesce($4::timestamptz, now()), cancel_protocol = $5, cancel_event_seq = $6
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3`,
        [scope.tenantId, scope.cnpj, chave, e.dh_evento, e.protocolo, r.event!.event_seq],
      );
      await this.pool.query(
        `update dfe_events set applied_at = now()
          where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3
            and tp_evento = any($4::text[]) and applied_at is null`,
        [scope.tenantId, scope.cnpj, chave, TP_CANCELAMENTO],
      );
      aplicados.add(chave);
      resumo.cancellations += 1;
    }
  }

  private async bloquearEvento(
    scope: EventScope,
    e: { access_key: string; tp_evento: string; n_seq_evento: number },
    motivo: string,
  ): Promise<void> {
    await this.pool.query(
      `update dfe_events set blocked_reason = $6
        where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = $3
          and tp_evento = $4 and n_seq_evento = $5`,
      [scope.tenantId, scope.cnpj, e.access_key, e.tp_evento, e.n_seq_evento, motivo],
    );
  }

  // ------------------------------------------------------------ apoio

  private async credencial(scope: EventScope): Promise<CredencialA1> {
    const { rows } = await this.pool.query<{ encrypted_pfx: string; credential_format: string }>(
      `select encrypted_pfx, credential_format from certificates
        where tenant_id = $1::uuid and cnpj = $2::char(14)`,
      [scope.tenantId, scope.cnpj],
    );
    const linha = rows[0];
    if (linha === undefined) {
      throw new Error('O certificado A1 deste CNPJ foi removido depois do pedido.');
    }
    if (linha.credential_format !== 'pem_bundle') {
      throw new Error('O certificado deste CNPJ precisa ser reenviado para a coleta (ADR-006).');
    }
    return lerCredencial(this.vault.decrypt(linha.encrypted_pfx));
  }

  private async codigoUf(scope: EventScope): Promise<string> {
    const { rows } = await this.pool.query<{ uf: string | null }>(
      'select uf from clients where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    const codigo = CODIGO_UF[rows[0]?.uf?.trim().toUpperCase() ?? ''];
    if (codigo === undefined) {
      throw new Error('O cadastro do cliente não tem UF válida.');
    }
    return codigo;
  }

  private async bloqueadoAte(scope: EventScope): Promise<Date | null> {
    const { rows } = await this.pool.query<{ blocked_until: Date | null }>(
      'select blocked_until from dfe_sync_state where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    const ate = rows[0]?.blocked_until ?? null;
    return ate !== null && ate.getTime() > this.now().getTime() ? ate : null;
  }

  private async ultNsu(scope: EventScope): Promise<string> {
    const { rows } = await this.pool.query<{ ult_nsu: string }>(
      'select ult_nsu from dfe_sync_state where tenant_id = $1::uuid and cnpj = $2::char(14)',
      [scope.tenantId, scope.cnpj],
    );
    return rows[0]?.ult_nsu ?? NSU_ZERO;
  }

  private async gravarEstado(scope: EventScope, r: SyncSummary): Promise<void> {
    await this.pool.query(
      `insert into dfe_sync_state (tenant_id, cnpj, ult_nsu, max_nsu, last_cstat, last_motivo, last_run_at, blocked_until)
       values ($1::uuid, $2::char(14), $3, $4, $5, $6, now(), $7::timestamptz)
       on conflict (tenant_id, cnpj) do update set
         ult_nsu = excluded.ult_nsu, max_nsu = excluded.max_nsu,
         last_cstat = excluded.last_cstat, last_motivo = excluded.last_motivo,
         last_run_at = excluded.last_run_at, blocked_until = excluded.blocked_until`,
      [scope.tenantId, scope.cnpj, r.ult_nsu, r.max_nsu, r.last_cstat, r.last_motivo, r.blocked_until],
    );
  }

  private async guardarResumo(scope: EventScope, nsu: string, xml: string): Promise<void> {
    const r = lerResumoNfe(xml);
    await this.pool.query(
      `insert into dfe_summaries (tenant_id, cnpj, access_key, nsu, issuer_cnpj, issuer_name, issued_at, total_cents)
       values ($1::uuid, $2::char(14), $3, $4, $5, $6, $7::timestamptz, $8)
       on conflict (tenant_id, cnpj, access_key) do nothing`,
      [scope.tenantId, scope.cnpj, r.accessKey, nsu, r.issuerCnpj, r.issuerName, r.issuedAt, r.totalCents],
    );
  }

  /**
   * Todo evento fica guardado, aplicado ou não. Evento ilegível não trava a
   * coleta: o NSU já avançou, e ele segue contado em `events_seen`.
   */
  private async guardarEvento(scope: EventScope, nsu: string, xml: string): Promise<void> {
    let e;
    try {
      e = lerEventoNfe(xml);
    } catch {
      return;
    }
    // Evento que não vale contra a nota (136, rejeição) fica registrado já com o
    // motivo, e não é tentado.
    const motivo = eventoVinculado(e) ? null : `evento sem vínculo com a NF-e: cStat ${e.cStat ?? '?'}`;
    await this.pool.query(
      `insert into dfe_events (tenant_id, cnpj, access_key, tp_evento, n_seq_evento, nsu, cstat,
                               protocolo, dh_evento, xml, blocked_reason)
       values ($1::uuid, $2::char(14), $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)
       on conflict (tenant_id, cnpj, access_key, tp_evento, n_seq_evento) do update
         set cstat = coalesce(excluded.cstat, dfe_events.cstat),
             protocolo = coalesce(excluded.protocolo, dfe_events.protocolo),
             xml = case when excluded.cstat is not null then excluded.xml else dfe_events.xml end`,
      [scope.tenantId, scope.cnpj, e.accessKey, e.tpEvento, e.nSeqEvento, nsu, e.cStat, e.protocolo, e.dhEvento, xml, motivo],
    );
  }

  private async marcarRecebidos(scope: EventScope, chaves: string[]): Promise<void> {
    if (chaves.length === 0) return;
    await this.pool.query(
      `update dfe_summaries set received_at = coalesce(received_at, now())
        where tenant_id = $1::uuid and cnpj = $2::char(14) and access_key = any($3::char(44)[])`,
      [scope.tenantId, scope.cnpj, chaves],
    );
  }

  private async usoDoCertificado(
    orchestrator: FiscalOrchestratorService,
    scope: EventScope,
    actor: string,
    purpose: 'dfe_distribution' | 'manifestation',
    target: string,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    const r = await orchestrator.processIntention({
      action: 'certificate.used',
      task_id: scope.cnpj,
      actor,
      payload: { purpose, target, outcome },
    });
    if (!r.accepted) {
      throw new Error(`O uso do certificado não foi registrado no log: ${r.rejectionReason ?? 'recusado'}.`);
    }
  }
}
