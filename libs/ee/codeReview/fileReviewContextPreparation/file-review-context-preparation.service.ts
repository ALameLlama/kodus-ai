import { createLogger } from '@kodus/flow';
/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import { BYOKConfig, LLMModelProvider } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';

import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';


import { BaseFileReviewContextPreparation } from '@libs/code-review/infrastructure/adapters/services/code-analysis/file/base-file-review.abstract';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { BackoffPresets } from '@libs/common/utils/polling';
import { ReviewModeOptions } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import {
    AnalysisContext,
    FileChange,
    ReviewModeConfig,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';

/**
 * Enterprise (cloud) implementation of the file review context preparation service
 * Extends the base class and overrides methods to add advanced functionalities
 * Available only in the cloud version or with an enterprise license
 */
@Injectable()
export class FileReviewContextPreparation extends BaseFileReviewContextPreparation {
    protected readonly logger = createLogger(FileReviewContextPreparation.name);
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,
    ) {
        super();
    }

    /**
     * Get backoff configuration for heavy AST tasks
     * Uses linear backoff: 5s, 10s, 15s, 20s... up to 60s
     */
    private getHeavyTaskBackoffConfig() {
        return {
            initialInterval: BackoffPresets.HEAVY_TASK.baseInterval,
            maxInterval: BackoffPresets.HEAVY_TASK.maxInterval,
            useExponentialBackoff: false, // Linear mode
        };
    }

    /**
     * Overrides the method for determining the review mode to use advanced logic
     * @param file File to be analyzed
     * @param patch File patch
     * @param context Analysis context
     * @returns Determined review mode
     * @override
     */
    protected async determineReviewMode(
        options?: ReviewModeOptions,
        byokConfig?: BYOKConfig,
    ): Promise<ReviewModeResponse> {
        try {
            const { context } = options;

            let reviewMode = ReviewModeResponse.HEAVY_MODE;

            const shouldCheckMode =
                context?.codeReviewConfig?.reviewModeConfig ===
                    ReviewModeConfig.LIGHT_MODE_FULL ||
                context?.codeReviewConfig?.reviewModeConfig ===
                    ReviewModeConfig.LIGHT_MODE_PARTIAL;

            if (shouldCheckMode) {
                reviewMode = await this.getReviewMode(options, byokConfig);
            }

            return reviewMode;
        } catch (error) {
            this.logger.warn({
                message:
                    'Error determining advanced review mode, falling back to basic mode',
                error,
                context: FileReviewContextPreparation.name,
            });

            // In case of an error, we call the parent class method (basic implementation)
            // However, since BaseFileReviewContextPreparation is now abstract, we need to implement a fallback here
            return ReviewModeResponse.HEAVY_MODE;
        }
    }

    /**
     * Overrides the method for preparing the internal context to add AST analysis
     * @param file File to be analyzed
     * @param patchWithLinesStr Patch with line numbers
     * @param reviewMode Determined review mode
     * @param context Analysis context
     * @returns Prepared file context with AST analysis
     * @override
     */
    protected async prepareFileContextInternal(
        file: FileChange,
        patchWithLinesStr: string,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null> {
        const baseContext = await super.prepareFileContextInternal(
            file,
            patchWithLinesStr,
            context,
        );

        if (!baseContext) {
            return null;
        }

        const fileContext: AnalysisContext = {
            ...baseContext.fileContext,
            workflowJobId: context.workflowJobId, // Pass workflowJobId from pipeline context
        };

        return { fileContext };
    }

    private async getReviewMode(
        options: ReviewModeOptions,
        byokConfig: BYOKConfig,
    ): Promise<ReviewModeResponse> {
        const response = await this.aiAnalysisService.selectReviewMode(
            options.context.organizationAndTeamData,
            options.context.pullRequest.number,
            LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
            options.fileChangeContext.file,
            options.patch,
            byokConfig,
        );

        return response;
    }

    protected async getRelevantFileContent(
        file: FileChange,
        context: AnalysisContext,
    ): Promise<{
        relevantContent: string | null;
        taskStatus?: TaskStatus;
        hasRelevantContent?: boolean;
    }> {
        try {
            const { taskId } = context.tasks.astAnalysis;

            if (!taskId) {
                this.logger.warn({
                    message:
                        'No AST analysis task ID found, returning file content',
                    context: FileReviewContextPreparation.name,
                    metadata: {
                        ...context?.organizationAndTeamData,
                        filename: file.filename,
                    },
                });

                return {
                    relevantContent: file.fileContent || file.content || null,
                    hasRelevantContent: false,
                    taskStatus: TaskStatus.TASK_STATUS_FAILED,
                };
            } else {
                this.logger.warn({
                    message: 'No relevant content found for the file',
                    context: FileReviewContextPreparation.name,
                    metadata: {
                        ...context?.organizationAndTeamData,
                        filename: file.filename,
                        task: { taskId },
                    },
                });
                return {
                    relevantContent: file.fileContent || file.content || null,
                    hasRelevantContent: false,
                };
            }
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving relevant file content',
                error,
                context: FileReviewContextPreparation.name,
                metadata: {
                    ...context?.organizationAndTeamData,
                    filename: file.filename,
                },
            });
            return {
                relevantContent: file.fileContent || file.content || null,
                taskStatus: TaskStatus.TASK_STATUS_FAILED,
                hasRelevantContent: false,
            };
        }
    }

    private updateContextWithTaskStatus(
        context: AnalysisContext,
        taskStatus: TaskStatus,
        type: keyof AnalysisContext['tasks'],
    ): AnalysisContext {
        return {
            ...context,
            tasks: {
                ...context.tasks,
                [type]: {
                    ...context.tasks[type],
                    status: taskStatus,
                },
            },
        };
    }
}
