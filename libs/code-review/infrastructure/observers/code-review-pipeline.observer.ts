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
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.IN_PROGRESS,
            'Starting...',
            context,
            options,
        );
    }

    async onStageFinish(
        stageName: string,
        context: CodeReviewPipelineContext,
        options?: { visibility?: StageVisibility; label?: string },
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

        const ignoredFilesMetadata = this.getIgnoredFilesMetadata(
            stageName,
            context,
        );
        if (ignoredFilesMetadata) {
            additionalMetadata = additionalMetadata || {};
            Object.assign(additionalMetadata, ignoredFilesMetadata);
        }

        let status =
            errors.length > 0
                ? AutomationStatus.PARTIAL_ERROR
                : AutomationStatus.SUCCESS;

        let label = options?.label;

        if (stageName === 'FileAnalysisStage') {
            const totalFiles = context.changedFiles?.length || 0;
            const errorCount = errors.length;

            if (errorCount > 0) {
                if (errorCount >= totalFiles) {
                    status = AutomationStatus.ERROR;
                } else {
                    status = AutomationStatus.PARTIAL_ERROR;
                }
            }

            label = `Reviewing File Level (${totalFiles} files)`;
        }

        if (stageName === 'CreatePrLevelCommentsStage') {
            const count = context.validSuggestionsByPR?.length || 0;
            label = `Drafting Comments (${count} items)`;
        }

        if (stageName === 'CreateFileCommentsStage') {
            const count = context.validSuggestions?.length || 0;
            label = `Posting File Comments (${count} items)`;
        }

        const message = errors.length > 0 ? 'Completed' : '';

        await this.logStage(stageName, status, message, context, {
            additionalMetadata,
            ...options,
            label,
        });
    }

    async onStageError(
        stageName: string,
        error: Error,
        context: CodeReviewPipelineContext,
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.ERROR,
            error.message,
            context,
            options,
        );
    }

    async onStageSkipped(
        stageName: string,
        reason: string,
        context: CodeReviewPipelineContext,
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        const additionalMetadata = this.getIgnoredFilesMetadata(
            stageName,
            context,
        );

        await this.logStage(
            stageName,
            AutomationStatus.SKIPPED,
            reason,
            context,
            { ...options, additionalMetadata },
        );
    }

    private getIgnoredFilesMetadata(
        stageName: string,
        context: CodeReviewPipelineContext,
    ): Record<string, any> | undefined {
        if (
            stageName === 'FetchChangedFilesStage' &&
            context.ignoredFiles &&
            context.ignoredFiles.length > 0
        ) {
            return {
                ignoredFiles: context.ignoredFiles.slice(0, 50),
            };
        }
        return undefined;
    }

    private async logStage(
        stageName: string,
        status: AutomationStatus,
        message: string,
        context: CodeReviewPipelineContext,
        options?: {
            visibility?: StageVisibility;
            label?: string;
            additionalMetadata?: Record<string, any>;
        },
    ): Promise<void> {
        let executionUuid =
            context.pipelineMetadata?.lastExecution?.uuid ||
            context.correlationId;
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

        const { visibility, label, additionalMetadata } = options || {};
        const metadata: any = visibility ? { visibility } : {};

        if (label) {
            metadata.label = label;
        }

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
                        AutomationStatus.PARTIAL_ERROR,
                        AutomationStatus.SKIPPED,
                    ].includes(status)
                ) {
                    updateData.finishedAt = new Date();
                }

                if (metadataToSend) {
                    updateData.metadata = {
                        ...(found.metadata || {}),
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
