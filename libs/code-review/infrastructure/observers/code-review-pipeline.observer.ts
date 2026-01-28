import { IPipelineObserver } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-observer.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { createLogger } from '@kodus/flow';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';

@Injectable()
export class CodeReviewPipelineObserver implements IPipelineObserver {
    private readonly logger = createLogger(CodeReviewPipelineObserver.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
    ) {}

    async onStageStart(
        stageName: string,
        context: CodeReviewPipelineContext,
        visibility?: StageVisibility,
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.IN_PROGRESS,
            `Starting stage ${stageName}`,
            context,
            { visibility },
        );
    }

    async onStageFinish(
        stageName: string,
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        const errors =
            context.errors?.filter((e) => e.stage === stageName) || [];
        let additionalMetadata: Record<string, any> | undefined;

        if (errors.length > 0) {
            additionalMetadata = {
                partialErrors: errors.map((e) => ({
                    file: e.substage || 'unknown',
                    message: e.error?.message || String(e.error),
                    ...e.metadata,
                })),
            };
        }

        await this.logStage(
            stageName,
            AutomationStatus.SUCCESS,
            `Completed stage ${stageName}`,
            context,
            { additionalMetadata },
        );
    }

    async onStageError(
        stageName: string,
        error: Error,
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.ERROR,
            `Error in stage ${stageName}: ${error.message}`,
            context,
        );
    }

    async onStageSkipped(
        stageName: string,
        reason: string,
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.SKIPPED,
            `Stage ${stageName} skipped: ${reason}`,
            context,
        );
    }

    private async logStage(
        stageName: string,
        status: AutomationStatus,
        message: string,
        context: CodeReviewPipelineContext,
        options?: {
            visibility?: StageVisibility;
            additionalMetadata?: Record<string, any>;
        },
    ): Promise<void> {
        let executionUuid = context.pipelineMetadata?.lastExecution?.uuid;
        const pullRequestNumber = context.pullRequest?.number;
        const repositoryId = context.repository?.id;

        if (!executionUuid && (!pullRequestNumber || !repositoryId)) {
            this.logger.warn({
                message: 'Missing context data for logging stage',
                context: CodeReviewPipelineObserver.name,
                metadata: {
                    stageName,
                    status,
                    executionUuid,
                    pullRequestNumber,
                    repositoryId,
                },
            });
            return;
        }

        const { visibility, additionalMetadata } = options || {};
        const metadata = visibility ? { visibility } : {};

        if (additionalMetadata) {
            Object.assign(metadata, additionalMetadata);
        }

        const metadataToSend =
            Object.keys(metadata).length > 0 ? metadata : undefined;

        if (status === AutomationStatus.IN_PROGRESS) {
            const filter: Partial<IAutomationExecution> = executionUuid
                ? { uuid: executionUuid }
                : { pullRequestNumber, repositoryId };

            await this.automationExecutionService.updateCodeReview(
                filter,
                { status },
                message,
                stageName,
                metadataToSend,
            );
            return;
        }

        if (!executionUuid) {
            const found =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        pullRequestNumber,
                        repositoryId,
                        status: AutomationStatus.IN_PROGRESS,
                    },
                );

            if (found) {
                executionUuid = found.uuid;
            }
        }

        if (executionUuid) {
            const found =
                await this.automationExecutionService.findLatestStageLog(
                    executionUuid,
                    stageName,
                );

            if (found) {
                const updateData: any = { status, message };
                if (
                    [
                        AutomationStatus.SUCCESS,
                        AutomationStatus.ERROR,
                        AutomationStatus.SKIPPED,
                    ].includes(status)
                ) {
                    updateData.finishedAt = new Date();
                }

                if (metadataToSend) {
                    updateData.metadata = {
                        ...updateData.metadata,
                        ...metadataToSend,
                    };
                }

                await this.automationExecutionService.updateStageLog(
                    found.uuid,
                    updateData,
                );
                return;
            }
        }

        const filter: Partial<IAutomationExecution> = executionUuid
            ? { uuid: executionUuid }
            : { pullRequestNumber, repositoryId };

        await this.automationExecutionService.updateCodeReview(
            filter,
            { status },
            message,
            stageName,
            metadataToSend,
        );
    }
}
