import * as os from 'os';
import { createLogger } from '@kodus/flow';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    Injectable,
    Inject,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { OutboxMessageModel } from './repositories/schemas/outbox-message.model';

import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
    MessagePayload,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import {
    calculateBackoffInterval,
    BackoffOptions,
} from '@libs/common/utils/polling';

/**
 * Backoff configuration for outbox relay.
 * Progression: 2s, 4s, 8s, 16s, 32s, 64s, ... up to 1 hour
 */
const OUTBOX_BACKOFF: BackoffOptions = {
    baseInterval: 2000, // 2 seconds
    maxInterval: 3600000, // 1 hour
    jitterFactor: 0.1, // ±10% jitter
    multiplier: 2, // Exponential
};

const DEFAULT_OUTBOX_MAX_ATTEMPTS = 3;
const DEFAULT_OUTBOX_PUBLISH_TIMEOUT_MS = 15000;

function parsePositiveIntEnv(envKey: string, fallback: number): number {
    const raw = process.env[envKey];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

// Helper interface to type the payload content we expect
interface MessagePayloadContent {
    correlationId?: string;
    workflowType?: string;
    jobId?: string;
    [key: string]: unknown;
}

@Injectable()
export class OutboxRelayService
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private isDestroyed = false;
    private isCleaning = false;
    private readonly instanceId = os.hostname();
    private readonly maxAttemptsOutbox = parsePositiveIntEnv(
        'WORKFLOW_OUTBOX_MAX_ATTEMPTS',
        DEFAULT_OUTBOX_MAX_ATTEMPTS,
    );
    private readonly publishTimeoutMs = parsePositiveIntEnv(
        'WORKFLOW_OUTBOX_PUBLISH_TIMEOUT_MS',
        DEFAULT_OUTBOX_PUBLISH_TIMEOUT_MS,
    );

    private readonly BATCH_SIZE = 50;
    private readonly MIN_INTERVAL = 100; // 100ms when there is work
    private readonly MAX_INTERVAL = 3000; // 3s when idle (optimized for better latency)
    private currentInterval = 1000;

    private readonly logger = createLogger(OutboxRelayService.name);

    constructor(
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
        private readonly observability: ObservabilityService,
    ) {}

    onApplicationBootstrap() {
        this.logger.log({
            message: 'Starting OutboxRelayService with adaptive polling',
            context: OutboxRelayService.name,
            metadata: {
                instanceId: this.instanceId,
                maxAttemptsOutbox: this.maxAttemptsOutbox,
                publishTimeoutMs: this.publishTimeoutMs,
            },
        });

        // Start the recursive polling loop
        this.poll().catch((err) => {
            this.logger.error({
                message: 'Fatal error in outbox poll loop',
                context: OutboxRelayService.name,
                error: err,
            });
        });
    }

    onModuleDestroy() {
        this.isDestroyed = true;
    }

    private async poll(): Promise<void> {
        if (this.isDestroyed) {
            return;
        }

        try {
            const processedCount = await this.processOutbox();

            // Adaptive interval
            if (processedCount > 0) {
                this.currentInterval = this.MIN_INTERVAL;
            } else {
                this.currentInterval = Math.min(
                    this.currentInterval * 2,
                    this.MAX_INTERVAL,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error during outbox processing cycle',
                context: OutboxRelayService.name,
                error,
            });
            this.currentInterval = this.MAX_INTERVAL;
        } finally {
            if (!this.isDestroyed) {
                setTimeout(() => this.poll(), this.currentInterval);
            }
        }
    }

    /**
     * Processa mensagens pendentes do outbox e publica no RabbitMQ.
     * Returns the number of successfully processed messages (for adaptive polling).
     */
    async processOutbox(): Promise<number> {
        // Claim a batch of messages atomically
        const messages = await this.outboxRepository.claimBatch(
            this.BATCH_SIZE,
            this.instanceId,
        );

        if (messages.length === 0) {
            return 0;
        }

        return await this.observability.runInSpan(
            'workflow.outbox.relay',
            async (span) => {
                this.logger.log({
                    message: 'Processing outbox batch',
                    context: OutboxRelayService.name,
                    metadata: { count: messages.length },
                });

                // Process each message individually to avoid batch blocking
                const results = await Promise.allSettled(
                    messages.map((m) => this.processMessage(m)),
                );

                const successCount = results.filter(
                    (r) => r.status === 'fulfilled',
                ).length;

                span.setAttributes({
                    'workflow.outbox.batch_size': messages.length,
                    'workflow.outbox.success_count': successCount,
                });

                // Return successCount for adaptive polling (not batch size)
                // If all messages fail, we should slow down, not speed up
                return successCount;
            },
            {
                'workflow.component': 'outbox',
                'workflow.operation': 'relay',
            },
        );
    }

    /**
     * Reaper to reclaim messages stuck in PROCESSING (Outbox)
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async reclaimStaleOutbox(): Promise<void> {
        const fiveMinutesAgo = new Date();
        fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

        const reclaimed =
            await this.outboxRepository.reclaimStaleMessages(fiveMinutesAgo);

        if (reclaimed > 0) {
            this.logger.log({
                message: `Reclaimed ${reclaimed} stale outbox messages`,
                context: OutboxRelayService.name,
            });
        }
    }

    /**
     * Reaper to reclaim messages stuck in PROCESSING (Inbox)
     * This handles cases where a consumer crashed mid-processing.
     *
     * Uses consumer-specific timeouts based on the type of work:
     * - Webhooks: 20 minutes (job timeout is 10min + margin)
     * - Check implementation: 20 minutes (job timeout is 10min + margin)
     * - Code reviews: 12 hours (very conservative to avoid reprocessing without checkpoints)
     *
     * PERFORMANCE NOTE: Uses separate queries per consumer for better index utilization.
     * Requires partial indexes:
     *   CREATE INDEX CONCURRENTLY idx_inbox_webhook_stale
     *     ON kodus_workflow.inbox_messages (lockedAt)
     *     WHERE consumerId = 'workflow-job-consumer.webhook' AND status = 'PROCESSING';
     *   CREATE INDEX CONCURRENTLY idx_inbox_check_implementation_stale
     *     ON kodus_workflow.inbox_messages (lockedAt)
     *     WHERE consumerId = 'workflow-job-consumer.check_implementation' AND status = 'PROCESSING';
     *   CREATE INDEX CONCURRENTLY idx_inbox_codereview_stale
     *     ON kodus_workflow.inbox_messages (lockedAt)
     *     WHERE consumerId = 'workflow-job-consumer.code_review' AND status = 'PROCESSING';
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async reclaimStaleInbox(): Promise<void> {
        return await this.observability.runInSpan(
            'workflow.inbox.reaper',
            async (span) => {
                let totalReclaimed = 0;
                const startTime = Date.now();

                // Define timeouts per consumer type
                // Each timeout is ~1.5-2x the actual job timeout to account for overhead
                const consumerTimeouts = {
                    'workflow-job-consumer.webhook': 20 * 60 * 1000, // 20 minutes
                    'workflow-job-consumer.check_implementation':
                        20 * 60 * 1000, // 20 minutes
                    'workflow-job-consumer.code_review': 12 * 60 * 60 * 1000, // 12 hours (very conservative to avoid reprocessing without checkpoints)
                };

                // Reclaim messages for each consumer type with its specific timeout
                for (const [consumerId, timeoutMs] of Object.entries(
                    consumerTimeouts,
                )) {
                    const threshold = new Date(Date.now() - timeoutMs);
                    const reclaimed =
                        await this.inboxRepository.reclaimStaleMessagesByConsumer(
                            consumerId,
                            threshold,
                        );

                    if (reclaimed > 0) {
                        totalReclaimed += reclaimed;
                        this.logger.warn({
                            message: `Reclaimed ${reclaimed} stale ${consumerId} messages`,
                            context: OutboxRelayService.name,
                            metadata: {
                                consumerId,
                                thresholdMinutes: timeoutMs / 60000,
                                reclaimedCount: reclaimed,
                                ageThreshold: threshold.toISOString(),
                            },
                        });

                        // Alert if reclaim rate is high (possible systemic issue)
                        if (reclaimed > 5) {
                            this.logger.error({
                                message: `HIGH RECLAIM RATE: ${reclaimed} ${consumerId} jobs stuck!`,
                                context: OutboxRelayService.name,
                                metadata: {
                                    consumerId,
                                    reclaimed,
                                    possibleCause:
                                        'Worker crashes, memory issues, or job timeouts',
                                },
                            });
                        }
                    }
                }

                const duration = Date.now() - startTime;

                span.setAttributes({
                    'workflow.inbox.reaper.reclaimed': totalReclaimed,
                    'workflow.inbox.reaper.duration_ms': duration,
                });

                if (totalReclaimed > 0) {
                    this.logger.log({
                        message: `Inbox reaper completed: ${totalReclaimed} messages reclaimed in ${duration}ms`,
                        context: OutboxRelayService.name,
                        metadata: {
                            totalReclaimed,
                            durationMs: duration,
                        },
                    });
                }
            },
            {
                'workflow.component': 'reaper',
                'workflow.operation': 'reclaim_inbox',
            },
        );
    }

    /**
     * Data Hygiene: Cleans up processed messages older than 7 days.
     * Runs daily at midnight.
     */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async cleanupOldMessages(): Promise<void> {
        if (this.isCleaning) return;
        this.isCleaning = true;

        try {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            this.logger.log({
                message: 'Starting cleanup of old outbox/inbox messages',
                context: OutboxRelayService.name,
                metadata: { threshold: sevenDaysAgo },
            });

            const deletedOutboxCount =
                await this.outboxRepository.deleteProcessedOlderThan(
                    sevenDaysAgo,
                );

            const deletedInboxCount =
                await this.inboxRepository.deleteProcessedOlderThan(
                    sevenDaysAgo,
                );

            this.logger.log({
                message: 'Completed cleanup of old messages',
                context: OutboxRelayService.name,
                metadata: { deletedOutboxCount, deletedInboxCount },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to cleanup old messages',
                context: OutboxRelayService.name,
                error,
            });
        } finally {
            this.isCleaning = false;
        }
    }

    private async processMessage(message: OutboxMessageModel): Promise<void> {
        return await this.observability.runInSpan(
            'workflow.outbox.publish',
            async (span) => {
                span.setAttributes({
                    'workflow.outbox.message.id': message.uuid,
                    'workflow.outbox.exchange': message.exchange,
                    'workflow.outbox.routing_key': message.routingKey,
                    'workflow.outbox.attempts': message.attempts,
                    'workflow.outbox.max_attempts': this.maxAttemptsOutbox,
                });

                try {
                    // Note: message.job is not populated by RETURNING * (only job_id column)
                    // Always use payload.jobId which is set during enqueue
                    const rawPayload = message?.payload as unknown as
                        | MessagePayload<MessagePayloadContent>
                        | MessagePayloadContent
                        | undefined;

                    const payloadContent =
                        (rawPayload as MessagePayload<MessagePayloadContent>)
                            ?.payload ??
                        (rawPayload as MessagePayloadContent) ??
                        {};

                    const correlationId = payloadContent?.correlationId;
                    const workflowType = payloadContent?.workflowType;
                    const jobId = payloadContent?.jobId;

                    span.setAttributes({
                        'workflow.outbox.job.id': jobId,
                    });

                    await this.messageBroker.publishMessage(
                        {
                            exchange: message.exchange,
                            routingKey: message.routingKey,
                        },
                        message.payload as unknown as MessagePayload,
                        {
                            messageId: message.uuid,
                            correlationId,
                            persistent: true,
                            timeout: this.publishTimeoutMs,
                            headers: {
                                'x-correlation-id': correlationId,
                                'x-workflow-type': workflowType,
                                'x-job-id': jobId,
                                'x-outbox-id': message.uuid,
                                'x-attempts': message.attempts,
                            },
                        },
                    );

                    await this.outboxRepository.markAsSent(message.uuid);

                    this.logger.debug({
                        message: 'Outbox message published',
                        context: OutboxRelayService.name,
                        metadata: {
                            messageId: message.uuid,
                            jobId,
                            exchange: message.exchange,
                            routingKey: message.routingKey,
                        },
                    });
                } catch (error) {
                    if (message.attempts >= this.maxAttemptsOutbox) {
                        // Permanently failed - mark as FAILED and alert
                        await this.outboxRepository.markAsPermanentlyFailed(
                            message.uuid,
                            error.message,
                        );

                        // CRITICAL: Also mark the workflow job as FAILED to prevent orphaned PENDING jobs
                        if (jobId) {
                            try {
                                await this.jobRepository.update(jobId, {
                                    status: JobStatus.FAILED,
                                    errorClassification: ErrorClassification.PERMANENT,
                                    lastError: `Outbox message failed after ${this.maxAttemptsOutbox} attempts: ${error.message}`,
                                });

                                this.logger.log({
                                    message: 'Job marked as FAILED due to outbox publish failure',
                                    context: OutboxRelayService.name,
                                    metadata: {
                                        jobId,
                                        messageId: message.uuid,
                                        attempts: message.attempts,
                                    },
                                });
                            } catch (updateError) {
                                this.logger.error({
                                    message: 'Failed to update job status to FAILED after outbox failure',
                                    context: OutboxRelayService.name,
                                    error: updateError,
                                    metadata: {
                                        jobId,
                                        messageId: message.uuid,
                                        originalError: error.message,
                                    },
                                });
                            }
                        }

                        this.logger.error({
                            message:
                                'Outbox message permanently failed after max attempts',
                            context: OutboxRelayService.name,
                            error,
                            metadata: {
                                messageId: message.uuid,
                                jobId,
                                attempts: message.attempts,
                                maxAttempts: this.maxAttemptsOutbox,
                            },
                        });
                    } else {
                        // Schedule for retry using centralized backoff
                        const delayMs = calculateBackoffInterval(
                            message.attempts,
                            OUTBOX_BACKOFF,
                        );
                        const nextAttemptAt = new Date(Date.now() + delayMs);

                        await this.outboxRepository.markAsFailed(
                            message.uuid,
                            error.message,
                            nextAttemptAt,
                        );

                        this.logger.warn({
                            message:
                                'Failed to publish outbox message, scheduled for retry',
                            context: OutboxRelayService.name,
                            error,
                            metadata: {
                                messageId: message.uuid,
                                attempts: message.attempts,
                                delayMs,
                                nextAttemptAt,
                            },
                        });
                    }

                    throw error;
                }
            },
        );
    }
}
