/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { createLogger } from '@kodus/flow';
import { Injectable, Inject } from '@nestjs/common';

import {
    GitHubReaction,
    GitlabReaction,
    ForgejoReaction,
    ReviewStatusReaction,
} from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { PipelineFactory } from '@libs/core/infrastructure/pipeline/services/pipeline-factory.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';

@Injectable()
export class CodeReviewHandlerService {
    private readonly logger = createLogger(CodeReviewHandlerService.name);

    private readonly reactionMap = {
        [PlatformType.GITHUB]: {
            [ReviewStatusReaction.START]: GitHubReaction.ROCKET,
            [ReviewStatusReaction.SUCCESS]: GitHubReaction.HOORAY,
            [ReviewStatusReaction.ERROR]: GitHubReaction.CONFUSED,
            [ReviewStatusReaction.SKIP]: GitHubReaction.EYES,
        },
        [PlatformType.GITLAB]: {
            [ReviewStatusReaction.START]: GitlabReaction.ROCKET,
            [ReviewStatusReaction.SUCCESS]: GitlabReaction.TADA,
            [ReviewStatusReaction.ERROR]: GitlabReaction.CONFUSED,
            [ReviewStatusReaction.SKIP]: GitlabReaction.EYES,
        },
        [PlatformType.FORGEJO]: {
            [ReviewStatusReaction.START]: ForgejoReaction.ROCKET,
            [ReviewStatusReaction.SUCCESS]: ForgejoReaction.HOORAY,
            [ReviewStatusReaction.ERROR]: ForgejoReaction.CONFUSED,
            [ReviewStatusReaction.SKIP]: ForgejoReaction.EYES,
        },
    };

    constructor(
        @Inject('PIPELINE_PROVIDER')
        private readonly pipelineFactory: PipelineFactory<CodeReviewPipelineContext>,
        private readonly observabilityService: ObservabilityService,
        private readonly codeManagement: CodeManagementService,
    ) {}

    async handlePullRequest(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: any,
        branch: string,
        pullRequest: any,
        platformType: string,
        teamAutomationId: string,
        origin: string,
        action: string,
        executionId: string,
        triggerCommentId?: number | string,
        userGitId?: string,
        workflowJobId?: string, // Optional: ID of workflow job (for pausing/resuming)
        lastExecutionData?: any, // Data from the last successful execution
        correlationId?: string,
    ) {
        let initialContext: CodeReviewPipelineContext;

        try {
            initialContext = {
                correlationId,
                workflowJobId,
                dryRun: {
                    enabled: false,
                },
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                    message: 'Pipeline started',
                },
                pipelineVersion: '1.0.1',
                errors: [],
                organizationAndTeamData,
                repository,
                pullRequest,
                branch,
                teamAutomationId,
                origin,
                action,
                platformType: platformType as PlatformType,
                triggerCommentId,
                userGitId,
                pipelineMetadata: {
                    lastExecution: {
                        ...(lastExecutionData || null),
                        uuid: executionId,
                    },
                },
                batches: [],
                preparedFileContexts: [],
                validSuggestions: [],
                discardedSuggestions: [],
                lastAnalyzedCommit: null,
                validSuggestionsByPR: [],
                validCrossFileSuggestions: [],
                tasks: {
                    astAnalysis: {
                        taskId: null,
                        status: TaskStatus.TASK_STATUS_UNSPECIFIED,
                    },
                },
                externalPromptContext: {},
                externalPromptLayers: undefined,
            };

            // Add START reaction before pipeline
            await this.addStatusReaction(
                initialContext,
                ReviewStatusReaction.START,
            );

            const pipeline =
                this.pipelineFactory.getPipeline('CodeReviewPipeline');
            const result = await pipeline.execute(initialContext);

            // Handle reactions based on result status
            await this.handleReactionsByStatus(initialContext, result);

            this.logger.log({
                message: `Code review pipeline completed successfully for PR#${pullRequest.number}`,
                context: CodeReviewHandlerService.name,
                serviceName: CodeReviewHandlerService.name,
                metadata: {
                    suggestionsCount: result?.lineComments?.length || 0,
                    organizationAndTeamData,
                    pullRequestNumber: pullRequest.number,
                    executionId,
                },
            });

            const finalStatus =
                result.statusInfo.status === AutomationStatus.IN_PROGRESS
                    ? {
                          status: AutomationStatus.SUCCESS,
                          message: 'Code review completed successfully',
                      }
                    : result.statusInfo;

            return {
                lastAnalyzedCommit: result?.lastAnalyzedCommit,
                commentId: result?.initialCommentData?.commentId,
                noteId: result?.initialCommentData?.noteId,
                threadId: result?.initialCommentData?.threadId,
                automaticReviewStatus: result?.automaticReviewStatus,
                statusInfo: finalStatus,
            };
        } catch (error) {
            if (initialContext) {
                await this.removeCurrentReaction(initialContext);
                await this.addStatusReaction(
                    initialContext,
                    ReviewStatusReaction.ERROR,
                );
            }

            this.logger.error({
                message: `Error executing code review pipeline for PR#${pullRequest.number}`,
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    pullRequestNumber: pullRequest.number,
                    executionId,
                },
            });

            return null;
        }
    }

    private async handleReactionsByStatus(
        context: CodeReviewPipelineContext,
        result: CodeReviewPipelineContext,
    ): Promise<void> {
        const status = result.statusInfo?.status;

        if (status === AutomationStatus.SKIPPED) {
            await this.removeCurrentReaction(context);
            await this.addStatusReaction(context, ReviewStatusReaction.SKIP);

            this.logger.log({
                message: `Review skipped for PR#${context.pullRequest.number} - adding skip reaction`,
                context: CodeReviewHandlerService.name,
                metadata: {
                    skipReason: result.statusInfo?.message,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return;
        }

        if (status === AutomationStatus.ERROR) {
            await this.removeCurrentReaction(context);
            await this.addStatusReaction(context, ReviewStatusReaction.ERROR);

            this.logger.error({
                message: `Review failed for PR#${context.pullRequest.number} - adding error reaction`,
                context: CodeReviewHandlerService.name,
                metadata: {
                    errorReason: result.statusInfo?.message,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return;
        }

        if (
            status === AutomationStatus.SUCCESS ||
            status === AutomationStatus.IN_PROGRESS
        ) {
            await this.removeCurrentReaction(context);
            await this.addStatusReaction(context, ReviewStatusReaction.SUCCESS);
            return;
        }
    }

    private async addStatusReaction(
        context: CodeReviewPipelineContext,
        status: ReviewStatusReaction,
    ): Promise<void> {
        try {
            const {
                organizationAndTeamData,
                repository,
                pullRequest,
                platformType,
                triggerCommentId,
            } = context;

            if (platformType === PlatformType.AZURE_REPOS) {
                return;
            }

            const reaction = this.reactionMap[platformType]?.[status];
            if (!reaction) {
                return;
            }

            if (triggerCommentId) {
                await this.codeManagement.addReactionToComment({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    commentId:
                        typeof triggerCommentId === 'string'
                            ? parseInt(triggerCommentId, 10)
                            : triggerCommentId,
                    reaction,
                });
            } else {
                await this.codeManagement.addReactionToPR({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    reaction,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error adding status reaction',
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    status,
                    platformType: context.platformType,
                    prNumber: context.pullRequest.number,
                },
            });
        }
    }

    private async removeCurrentReaction(
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        try {
            const {
                organizationAndTeamData,
                repository,
                pullRequest,
                platformType,
                triggerCommentId,
            } = context;

            if (platformType === PlatformType.AZURE_REPOS) {
                return;
            }

            const platformReactions = this.reactionMap[platformType];
            if (!platformReactions) {
                return;
            }

            const reactionsToRemove = Object.values(platformReactions) as (
                | GitHubReaction
                | GitlabReaction
            )[];

            if (triggerCommentId) {
                await this.codeManagement.removeReactionsFromComment({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    commentId:
                        typeof triggerCommentId === 'string'
                            ? parseInt(triggerCommentId, 10)
                            : triggerCommentId,
                    reactions: reactionsToRemove,
                });
            } else {
                await this.codeManagement.removeReactionsFromPR({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    reactions: reactionsToRemove,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing current reaction',
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    platformType: context.platformType,
                    prNumber: context.pullRequest.number,
                },
            });
        }
    }
}
