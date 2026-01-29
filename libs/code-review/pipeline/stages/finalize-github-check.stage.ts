import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { createLogger } from '@kodus/flow';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { PlatformType } from '@libs/core/domain/enums';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

@Injectable()
export class FinalizeGithubCheckStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'FinalizeGithubCheckStage';
    private readonly logger = createLogger(FinalizeGithubCheckStage.name);

    constructor(private readonly githubChecksService: GithubChecksService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (context.platformType !== PlatformType.GITHUB) {
            return context;
        }

        if (!context.githubCheckRunId) {
            this.logger.warn({
                message: `No GitHub Check Run ID found, skipping finalization`,
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest?.number,
                    organizationAndTeamData: context.organizationAndTeamData,
                    platformType: context.platformType,
                },
            });
            return context;
        }

        try {
            const [owner, repo] = context.repository.fullName?.split('/') || [];

            if (!owner || !repo) {
                return context;
            }

            // Count only comments that were actually posted successfully.
            // Previously this counted validSuggestions + validSuggestionsByPR +
            // validCrossFileSuggestions, which had two problems:
            // 1. Cross-file suggestions were double-counted (already merged into
            //    validSuggestions during file processing, AND counted separately)
            // 2. It counted prioritized suggestions instead of actually sent
            //    comments (some may be discarded by sortAndPrioritize or fail to post)
            const sentLineComments = (context.lineComments || []).filter(
                (c) => c.deliveryStatus === DeliveryStatus.SENT,
            );
            const sentPrComments = (
                context.prLevelCommentResults || []
            ).filter((c) => c.deliveryStatus === DeliveryStatus.SENT);
            const totalSuggestions =
                sentLineComments.length + sentPrComments.length;

            const hasErrors = context.pipelineError || false;

            if (hasErrors) {
                // Mark as failure if there was an error
                await this.githubChecksService.markFailure({
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: {
                        owner,
                        name: repo,
                    },
                    checkRunId: context.githubCheckRunId,
                    output: {
                        title: 'Code Review Failed',
                        summary:
                            'An error occurred during the code review process. Please check the logs for details.',
                    },
                });
            } else {
                let summary = `✅ Kody found ${totalSuggestions} suggestion${
                    totalSuggestions === 1 ? '' : 's'
                }. Check the comments for details.`;

                if (totalSuggestions === 0) {
                    if (context.statusInfo.skippedReason?.message) {
                        summary = `ℹ️ ${context.statusInfo.skippedReason.message}`;
                    } else if (context.statusInfo?.message) {
                        summary = `ℹ️ ${context.statusInfo.message}`;
                    } else {
                        summary = '✅ No issues found. Great work!';
                    }
                }
                // Mark as success with suggestion count
                await this.githubChecksService.markSuccess({
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: {
                        owner,
                        name: repo,
                    },
                    checkRunId: context.githubCheckRunId,
                    output: {
                        title: 'Code Review Complete',
                        summary,
                    },
                });
            }

            this.logger.log({
                message: `Finalized GitHub Check`,
                context: this.stageName,
                metadata: {
                    checkRunId: context.githubCheckRunId,
                    totalSuggestions,
                    hasErrors,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error finalizing GitHub Check`,
                context: this.stageName,
                error,
                metadata: {
                    checkRunId: context.githubCheckRunId,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
        }

        return context;
    }
}
