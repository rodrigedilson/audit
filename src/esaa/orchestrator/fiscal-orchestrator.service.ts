import type { ESAAIntention, ESAAEventData } from '../shared/types/esaa-event.types.js';
import { IntegrityViolationError } from '../shared/types/esaa-errors.js';
import type { IEventStoreRepository } from '../core/event-store/event-store.repository.js';
import type { EventScope } from '../core/event-store/value-objects/event-scope.vo.js';
import { EventAppenderService } from '../core/event-store/event-appender.service.js';
import { EventReplayerService } from '../core/event-store/event-replayer.service.js';
import { ValidationPipelineService } from '../core/validation/validation-pipeline.service.js';
import { ContractLoaderService } from '../core/contracts/contract-loader.service.js';
import { ContractEnforcerService } from '../core/contracts/contract-enforcer.service.js';
import { Logger } from '../shared/infrastructure/logger.js';
import { FiscalProjectorService } from '../../fiscal/projection/fiscal-projector.service.js';
import { FiscalHashVerifierService } from '../../fiscal/projection/fiscal-hash-verifier.service.js';
import type { FiscalProjection } from '../../fiscal/shared/fiscal-projection.types.js';
import type { OutputRejectedPayload } from '../../fiscal/shared/fiscal-projection.types.js';

export interface VerifyReport {
  valid: boolean;
  eventCount: number;
  storedHash: string;
  replayedHash: string;
  contentHash: string;
  lastEventSeq: number;
}

export interface ProcessResult {
  accepted: boolean;
  event?: ESAAEventData;
  projection?: FiscalProjection;
  rejectionReason?: string;
  /** Camada que barrou, quando rejeitado. Alimenta o 422 do contrato. */
  layer?: number;
}

/**
 * Único escritor do event log de um par (tenant, CNPJ). Recebe intenções, roda
 * as 7 camadas e só então grava.
 *
 * Uma instância por escopo: a projeção em memória é do CNPJ que ela serve.
 */
export class FiscalOrchestratorService {
  private readonly appender: EventAppenderService;
  private readonly replayer: EventReplayerService;
  private readonly projector: FiscalProjectorService;
  private readonly hashVerifier: FiscalHashVerifierService;
  private readonly validationPipeline: ValidationPipelineService;
  private readonly logger: Logger;

  private currentProjection: FiscalProjection | null = null;

  constructor(
    eventStore: IEventStoreRepository,
    contractLoader: ContractLoaderService,
    private readonly scope: EventScope,
  ) {
    this.appender = new EventAppenderService(eventStore, scope);
    this.replayer = new EventReplayerService(eventStore);
    this.projector = new FiscalProjectorService();
    this.hashVerifier = new FiscalHashVerifierService(this.projector);
    this.validationPipeline = new ValidationPipelineService(
      new ContractEnforcerService(contractLoader),
      this.hashVerifier,
    );
    this.logger = new Logger('FiscalOrchestrator');
  }

  async initialize(): Promise<FiscalProjection> {
    const events = await this.replayer.replayAll();
    this.currentProjection = this.project(events);
    this.logger.info('Orquestrador inicializado', {
      scope: this.scope.toKey(),
      eventCount: events.length,
    });
    return this.currentProjection;
  }

  async processIntention(intention: ESAAIntention): Promise<ProcessResult> {
    if (!this.currentProjection) {
      await this.initialize();
    }

    const events = await this.replayer.replayAll();
    const validation = this.validationPipeline.validate(
      intention,
      this.currentProjection!,
      events,
    );

    if (!validation.valid) {
      return this.reject(intention, validation.errors[0]!);
    }

    const event = await this.appender.append({
      action: intention.action,
      taskId: intention.task_id,
      actor: intention.actor,
      payload: intention.payload,
      period: intention.period,
    });

    await this.reproject();

    // A releitura é deliberadamente independente da que a reprojeção fez: é o
    // que detecta um segundo escritor tendo acrescentado eventos entre o append
    // e a projeção. Reusar o mesmo array tornaria a verificação tautológica.
    const allEvents = await this.replayer.replayAll();
    const verification = this.hashVerifier.verify(allEvents, this.currentProjection!);

    if (!verification.valid) {
      this.logger.error('Integridade da projeção violada', {
        scope: this.scope.toKey(),
        storedHash: verification.storedHash,
        replayHash: verification.replayHash,
        contentHash: verification.contentHash,
        seq: event.event_seq,
      });
      throw new IntegrityViolationError(verification.storedHash, verification.replayHash);
    }

    this.logger.info('Intenção aceita', {
      scope: this.scope.toKey(),
      action: intention.action,
      actor: intention.actor,
      seq: event.event_seq,
    });

    return { accepted: true, event, projection: this.currentProjection! };
  }

  async getProjection(): Promise<FiscalProjection> {
    if (!this.currentProjection) {
      await this.initialize();
    }
    return this.currentProjection!;
  }

  /** Alimenta `POST /clients/{cnpj}/verify` do contrato. */
  async verify(): Promise<VerifyReport> {
    if (!this.currentProjection) {
      await this.initialize();
    }
    const events = await this.replayer.replayAll();
    const result = this.hashVerifier.verify(events, this.currentProjection!);

    return {
      valid: result.valid,
      eventCount: result.eventCount,
      storedHash: result.storedHash,
      replayedHash: result.replayHash,
      contentHash: result.contentHash,
      lastEventSeq: this.currentProjection!.last_event_seq,
    };
  }

  /**
   * A rejeição também vai para o log. É o que transforma "documento recusado" em
   * inconsistência auditável, com camada e motivo, em vez de um erro que se
   * perde na tela.
   */
  private async reject(
    intention: ESAAIntention,
    error: { layer: number; reason: string; details: string },
  ): Promise<ProcessResult> {
    this.logger.warn('Intenção rejeitada', {
      scope: this.scope.toKey(),
      action: intention.action,
      actor: intention.actor,
      reason: error.reason,
      layer: error.layer,
    });

    const payload: OutputRejectedPayload = {
      reason: error.reason,
      details: error.details,
      original_action: intention.action,
      validation_layer: error.layer,
    };

    const event = await this.appender.append({
      action: 'output.rejected',
      taskId: intention.task_id,
      actor: intention.actor,
      payload: payload as unknown as Record<string, unknown>,
      period: intention.period,
    });

    await this.reproject();

    return {
      accepted: false,
      event,
      projection: this.currentProjection!,
      rejectionReason: `Camada ${error.layer}: ${error.reason} — ${error.details}`,
      layer: error.layer,
    };
  }

  private project(events: readonly ESAAEventData[]): FiscalProjection {
    return this.projector.project(this.scope.tenantId, this.scope.cnpj, events);
  }

  private async reproject(): Promise<void> {
    this.currentProjection = this.project(await this.replayer.replayAll());
  }
}
