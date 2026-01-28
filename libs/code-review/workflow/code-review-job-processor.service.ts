import { createLogger } from '@kodus/flow';
import { Injectable, Inject, Optional } from '@nestjs/common';

import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    WORKFLOW_JOB_REPOSITORY_TOKEN,
    IWorkflowJobRepository,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { EnqueueCodeReviewJobInput } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';

@Injectable()
export class CodeReviewJobProcessorService implements IJobProcessorService {
    private readonly logger = createLogger(CodeReviewJobProcessorService.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly runCodeReviewAutomationUseCase: RunCodeReviewAutomationUseCase,
        @Optional()
        private readonly metricsCollector?: MetricsCollectorService,
    ) {}

    async process(jobId: string): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        const correlationId = job.correlationId;

        this.logger.log({
            message: `Processing Code Review Job ${jobId}`,
            context: CodeReviewJobProcessorService.name,
            metadata: { jobId, correlationId },
        });

        const startTime = Date.now();

        try {
            await this.jobRepository.update(jobId, {
                status: JobStatus.PROCESSING,
                startedAt: new Date(),
            });

            const jobPayload = job.payload || {};
            const {
                codeManagementPayload,
                event,
                platformType,
                organizationAndTeamData,
                teamAutomationId,
            } = jobPayload as EnqueueCodeReviewJobInput;

            if (
                !codeManagementPayload ||
                !event ||
                !platformType ||
                !organizationAndTeamData ||
                !teamAutomationId
            ) {
                throw new Error('Invalid payload: missing required fields');
            }

            await this.runCodeReviewAutomationUseCase.execute({
                codeManagementPayload,
                event,
                platformType,
                correlationId,
                organizationAndTeamData,
                teamAutomationId,
            });

            await this.markCompleted(jobId);

            const durationMs = Date.now() - startTime;
            this.metricsCollector?.recordHistogram(
                'code_review_duration_ms',
                durationMs,
                { status: 'success' },
            );
        } catch (error) {
            if (error.name === 'WorkflowPausedError') {
                await this.jobRepository.update(jobId, {
                    status: JobStatus.WAITING_FOR_EVENT,
                    waitingForEvent: {
                        eventType: error.eventType,
                        eventKey: error.eventKey,
                    },
                });
                return;
            }

            this.logger.error({
                message: `Job ${jobId} failed`,
                error,
                context: CodeReviewJobProcessorService.name,
            });

            await this.handleFailure(jobId, error);
            throw error;
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        this.metricsCollector?.recordCounter('code_review_errors_total', 1, {
            errorType: error.name || 'UnknownError',
        });

        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: error.message,
            failedAt: new Date(),
        });
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            result: result,
        });
    }
}
