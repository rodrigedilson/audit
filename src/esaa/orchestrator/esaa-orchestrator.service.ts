import type {
  ESAAIntention,
  ESAAEventData,
  MaterializedRoadmap,
  OutputRejectedPayload,
} from '../shared/types/esaa-event.types.js';
import { IntegrityViolationError } from '../shared/types/esaa-errors.js';
import type { IEventStoreRepository } from '../core/event-store/event-store.repository.js';
import { EventAppenderService } from '../core/event-store/event-appender.service.js';
import { EventReplayerService } from '../core/event-store/event-replayer.service.js';
import { ProjectorService } from '../core/projection/projector.service.js';
import { HashVerifierService } from '../core/projection/hash-verifier.service.js';
import { ValidationPipelineService } from '../core/validation/validation-pipeline.service.js';
import { ContractLoaderService } from '../core/contracts/contract-loader.service.js';
import { ContractEnforcerService } from '../core/contracts/contract-enforcer.service.js';
import { Logger } from '../shared/infrastructure/logger.js';

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
  roadmap?: MaterializedRoadmap;
  rejectionReason?: string;
}

export class ESAAOrchestratorService {
  private readonly appender: EventAppenderService;
  private readonly replayer: EventReplayerService;
  private readonly projector: ProjectorService;
  private readonly hashVerifier: HashVerifierService;
  private readonly validationPipeline: ValidationPipelineService;
  private readonly logger: Logger;

  private currentRoadmap: MaterializedRoadmap | null = null;

  constructor(
    eventStore: IEventStoreRepository,
    contractLoader: ContractLoaderService,
  ) {
    this.appender = new EventAppenderService(eventStore);
    this.replayer = new EventReplayerService(eventStore);
    this.projector = new ProjectorService();
    this.hashVerifier = new HashVerifierService(this.projector);
    const enforcer = new ContractEnforcerService(contractLoader);
    this.validationPipeline = new ValidationPipelineService(enforcer, this.hashVerifier);
    this.logger = new Logger('ESAAOrchestrator');
  }

  async initialize(): Promise<MaterializedRoadmap> {
    const events = await this.replayer.replayAll();
    this.currentRoadmap = this.projector.project(events);
    this.logger.info('Orchestrator initialized', { eventCount: events.length });
    return this.currentRoadmap;
  }

  async processIntention(intention: ESAAIntention): Promise<ProcessResult> {
    if (!this.currentRoadmap) {
      await this.initialize();
    }

    const events = await this.replayer.replayAll();

    // 1. Validate (7 layers)
    const validation = this.validationPipeline.validate(
      intention,
      this.currentRoadmap!,
      events,
    );

    if (!validation.valid) {
      const error = validation.errors[0];
      this.logger.warn('Intention rejected', {
        action: intention.action,
        actor: intention.actor,
        task_id: intention.task_id,
        reason: error.reason,
        layer: error.layer,
      });

      // Emit output.rejected event
      const rejectionPayload: OutputRejectedPayload = {
        reason: error.reason,
        details: error.details,
        original_action: intention.action,
        validation_layer: error.layer,
      };

      const rejectionEvent = await this.appender.append(
        'output.rejected',
        intention.task_id,
        'tech-lead',
        rejectionPayload as unknown as Record<string, unknown>,
      );

      await this.reproject();

      return {
        accepted: false,
        event: rejectionEvent,
        roadmap: this.currentRoadmap!,
        rejectionReason: `Layer ${error.layer}: ${error.reason} - ${error.details}`,
      };
    }

    // 2. Append event to store
    const event = await this.appender.append(
      intention.action,
      intention.task_id,
      intention.actor,
      intention.payload,
    );

    // 3. Re-project materialized view
    await this.reproject();

    // 4. Verify integrity.
    //
    // A releitura aqui é deliberadamente independente da que a reprojeção fez: é a
    // única coisa que hoje detecta um segundo escritor tendo acrescentado eventos
    // entre o append e a projeção. Reusar o array da reprojeção tornaria a
    // verificação tautológica (o roadmap acabou de sair daqueles mesmos eventos).
    // O custo de releitura é resolvido por snapshot e Postgres na Onda 1, não
    // abrindo mão desta checagem. Ver INV-005.
    const allEvents = await this.replayer.replayAll();
    const verification = this.hashVerifier.verify(allEvents, this.currentRoadmap!);

    if (!verification.valid) {
      this.logger.error('Integrity violation after projection', {
        storedHash: verification.storedHash,
        replayHash: verification.replayHash,
        contentHash: verification.contentHash,
        seq: event.event_seq,
      });

      // ORCHESTRATOR_CONTRACT: verification_mismatch é severidade crítica, e o nível
      // de escalação para crítico é halt_pipeline. O evento já está no log
      // append-only e não pode ser desfeito, mas seguir devolvendo `accepted: true`
      // com uma projeção que não fecha com o log entregaria ao contador um número
      // sem trilha — exatamente o que o produto promete impedir.
      throw new IntegrityViolationError(verification.storedHash, verification.replayHash);
    }

    this.logger.info('Intention accepted', {
      action: intention.action,
      actor: intention.actor,
      task_id: intention.task_id,
      seq: event.event_seq,
    });

    return {
      accepted: true,
      event,
      roadmap: this.currentRoadmap!,
    };
  }

  async getRoadmap(): Promise<MaterializedRoadmap> {
    if (!this.currentRoadmap) {
      await this.initialize();
    }
    return this.currentRoadmap!;
  }

  /** Alimenta `POST /clients/{cnpj}/verify` do contrato OpenAPI. */
  async verify(): Promise<VerifyReport> {
    if (!this.currentRoadmap) {
      await this.initialize();
    }
    const events = await this.replayer.replayAll();
    const result = this.hashVerifier.verify(events, this.currentRoadmap!);

    return {
      valid: result.valid,
      eventCount: result.eventCount,
      storedHash: result.storedHash,
      replayedHash: result.replayHash,
      contentHash: result.contentHash,
      lastEventSeq: this.currentRoadmap!.last_event_seq,
    };
  }

  private async reproject(): Promise<ESAAEventData[]> {
    const events = await this.replayer.replayAll();
    this.currentRoadmap = this.projector.project(events);
    return events;
  }
}
