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
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.IN_PROGRESS,
            `Starting stage ${stageName}`,
            context,
        );
    }

    async onStageFinish(
        stageName: string,
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.SUCCESS,
            `Completed stage ${stageName}`,
            context,
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
    ): Promise<void> {
        const executionUuid = context.pipelineMetadata?.lastExecution?.uuid;
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

        const filter: Partial<IAutomationExecution> = executionUuid
            ? { uuid: executionUuid }
            : { pullRequestNumber, repositoryId };

        await this.automationExecutionService.updateCodeReview(
            filter,
            {
                // We keep the parent status as IN_PROGRESS unless it's a failure
                status:
                    status === AutomationStatus.ERROR
                        ? AutomationStatus.ERROR
                        : AutomationStatus.IN_PROGRESS,
            },
            message,
            stageName,
        );
    }
}
