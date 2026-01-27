import { createHash } from 'crypto';

import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { CacheService } from '@libs/core/cache/cache.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { GenerateIssuesFromPrClosedUseCase } from '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import {
    IWebhookEventHandler,
    IWebhookEventParams,
} from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import {
    hasReviewMarker,
    isKodyMentionNonReview,
    isReviewCommand,
} from '@libs/common/utils/codeManagement/codeCommentMarkers';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';

@Injectable()
export class AzureReposPullRequestHandler implements IWebhookEventHandler {
    private readonly logger = createLogger(AzureReposPullRequestHandler.name);

    constructor(
        private readonly savePullRequestUseCase: SavePullRequestUseCase,
        private readonly webhookContextService: WebhookContextService,
        private readonly chatWithKodyFromGitUseCase: ChatWithKodyFromGitUseCase,
        private readonly cacheService: CacheService,
        private readonly generateIssuesFromPrClosedUseCase: GenerateIssuesFromPrClosedUseCase,
        private readonly eventEmitter: EventEmitter2,
        private readonly codeManagement: CodeManagementService,
        private readonly enqueueCodeReviewJobUseCase: EnqueueCodeReviewJobUseCase,
        private readonly enqueueImplementationCheckUseCase: EnqueueImplementationCheckUseCase,
    ) {}

    /**
     * Determines if this handler can process an Azure Repos webhook event.
     * @param params The webhook event parameters.
     * @returns True if the event is an Azure Repos event this handler supports, false otherwise.
     */
    public canHandle(params: IWebhookEventParams): boolean {
        if (params.platformType !== PlatformType.AZURE_REPOS) {
            return false;
        }

        const supportedEvents = [
            'git.pullrequest.created',
            'git.pullrequest.updated',
            'git.pullrequest.merge.attempted',
            'ms.vss-code.git-pullrequest-comment-event',
        ];
        return supportedEvents.includes(params.event);
    }

    /**
     * Processes an Azure Repos webhook event by calling the relevant use cases.
     * @param params The webhook event parameters.
     */
    public async execute(params: IWebhookEventParams): Promise<void> {
        const { event } = params;

        // Check if it's a duplicate request
        const isDuplicate = await this.isDuplicateRequest(params.payload);
        if (isDuplicate) {
            this.logger.warn({
                context: AzureReposPullRequestHandler.name,
                serviceName: AzureReposPullRequestHandler.name,
                message:
                    'Duplicate Azure Repos webhook request detected, skipping processing',
                metadata: {
                    eventType: event,
                    prId:
                        params.payload?.resource?.pullRequestId ||
                        'UNKNOWN_PR_ID',
                },
            });
            return;
        }

        // Direct to the appropriate method based on the event type
        if (event === 'ms.vss-code.git-pullrequest-comment-event') {
            await this.handleComment(params);
        } else {
            await this.handlePullRequest(params);
        }
    }

    /**
     * Processes Azure Repos pull request events
     */
    private async handlePullRequest(
        params: IWebhookEventParams,
    ): Promise<void> {
        const { payload, event } = params;
        const prId = params.payload?.resource?.pullRequestId || 'UNKNOWN_PR_ID';
        const eventType = params.event;
        const repoName =
            params.payload?.resource?.repository?.name || 'UNKNOWN_REPO';

        this.logger.log({
            context: AzureReposPullRequestHandler.name,
            serviceName: AzureReposPullRequestHandler.name,
            metadata: {
                prId,
                eventType,
                repoName,
            },
            message: `Processing Azure Repos event '${eventType}' for PR ID: ${prId} in repo ${repoName}`,
        });

        const repository = {
            id: params?.payload?.resource?.repository?.id,
            name: params?.payload?.resource?.repository?.name,
            fullName: params?.payload?.resource?.repository?.name,
        } as any;
        const context = await this.webhookContextService.getContext(
            PlatformType.AZURE_REPOS,
            String(repository.id),
        );

        // If no active automation found, complete the webhook processing immediately
        if (!context?.organizationAndTeamData) {
            this.logger.log({
                message: `No active automation found for repository, completing webhook processing`,
                context: AzureReposPullRequestHandler.name,
                metadata: {
                    prId,
                    eventType,
                    repoName,
                    repositoryId: repository.id,
                },
            });
            return;
        }

        try {
            switch (eventType) {
                case 'git.pullrequest.created':
                case 'git.pullrequest.updated':
                    await this.savePullRequestUseCase.execute(params);
                    if (
                        this.enqueueCodeReviewJobUseCase &&
                        context.organizationAndTeamData &&
                        params?.payload?.resource?.status !== 'abandoned'
                    ) {
                        const jobId =
                            await this.enqueueCodeReviewJobUseCase.execute({
                                codeManagementPayload: params.payload,
                                event: params.event,
                                platformType: PlatformType.AZURE_REPOS,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                correlationId: params.correlationId,
                                teamAutomationId: context.teamAutomationId,
                            });

                        this.logger.log({
                            message:
                                'Code review job enqueued for asynchronous processing',
                            context: AzureReposPullRequestHandler.name,
                            metadata: {
                                jobId,
                                prId,
                                repoName,
                                repositoryId: repository.id,
                            },
                        });
                    } else {
                        this.logger.log({
                            message:
                                'Skipping code review job enqueue (missing org/team or enqueue use case)',
                            context: AzureReposPullRequestHandler.name,
                            metadata: {
                                ...context,
                                hasOrgAndTeam:
                                    !!context.organizationAndTeamData,
                                prId,
                                repoName,
                                repositoryId: repository.id,
                            },
                        });
                    }

                    if (
                        eventType === 'git.pullrequest.updated' &&
                        params?.payload?.resource?.status !== 'abandoned'
                    ) {
                        try {
                            if (context.organizationAndTeamData) {
                                await this.enqueueImplementationCheckUseCase.execute(
                                    {
                                        organizationAndTeamData:
                                            context.organizationAndTeamData,
                                        repository: {
                                            id: repository.id,
                                            name: repository.name,
                                        },
                                        pullRequestNumber: Number(prId),
                                        commitSha:
                                            params.payload?.resource
                                                ?.lastMergeSourceCommit
                                                ?.commitId,
                                        payload: payload,
                                        event: event,
                                        platformType: PlatformType.AZURE_REPOS,
                                        trigger: payload?.action,
                                    },
                                );
                            }
                        } catch (e) {
                            this.logger.error({
                                message:
                                    'Failed to enqueue implementation check',
                                context: AzureReposPullRequestHandler.name,
                                error: e,
                                metadata: {
                                    repository,
                                    prId,
                                },
                            });
                        }
                    }

                    this.generateIssuesFromPrClosedUseCase.execute(params);

                    try {
                        if (params?.payload?.resource?.status === 'completed') {
                            if (context.organizationAndTeamData) {
                                const baseRefFull =
                                    params?.payload?.resource?.targetRefName; // refs/heads/main
                                const defaultBranch =
                                    await this.codeManagement.getDefaultBranch({
                                        organizationAndTeamData:
                                            context.organizationAndTeamData,
                                        repository: {
                                            id: repository.id,
                                            name: repository.name,
                                        },
                                    });
                                if (baseRefFull !== defaultBranch) {
                                    return;
                                }
                                const changedFiles =
                                    await this.codeManagement.getFilesByPullRequestId(
                                        {
                                            organizationAndTeamData:
                                                context.organizationAndTeamData,
                                            repository: {
                                                id: repository.id,
                                                name: repository.name,
                                            },
                                            prNumber:
                                                params?.payload?.resource
                                                    ?.pullRequestId,
                                        },
                                    );

                                this.eventEmitter.emit(
                                    'pull-request.closed',
                                    new PullRequestClosedEvent(
                                        context.organizationAndTeamData,
                                        repository,
                                        params?.payload?.resource
                                            ?.pullRequestId,
                                        changedFiles || [],
                                    ),
                                );
                            }
                        }
                    } catch (e) {
                        this.logger.error({
                            message: 'Failed to sync Kody Rules after PR merge',
                            context: AzureReposPullRequestHandler.name,
                            error: e,
                            metadata: {
                                prId,
                                eventType,
                                repoName,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                            },
                        });
                    }

                    break;
                case 'git.pullrequest.merge.attempted':
                    await this.savePullRequestUseCase.execute(params);
                    break;
                default:
                    this.logger.warn({
                        context: AzureReposPullRequestHandler.name,
                        message: `Event '${eventType}' for PR ID ${prId} passed canHandle but is not handled in execute.`,
                    });
                    return;
            }

            this.logger.log({
                context: AzureReposPullRequestHandler.name,
                serviceName: AzureReposPullRequestHandler.name,
                metadata: {
                    prId,
                    eventType,
                    repoName,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                message: `Successfully processed Azure Repos event '${eventType}' for PR ID: ${prId}`,
            });
        } catch (error) {
            this.logger.error({
                context: AzureReposPullRequestHandler.name,
                serviceName: AzureReposPullRequestHandler.name,
                metadata: {
                    prId,
                    eventType,
                    repoName,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                message: `Error processing Azure Repos pull request #${prId}: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    /**
     * Processes Azure Repos comment events
     */
    private async handleComment(params: IWebhookEventParams): Promise<void> {
        const { payload } = params;
        const prId =
            payload?.resource?.pullRequest?.pullRequestId || 'UNKNOWN_PR_ID';
        const repository = {
            id:
                payload?.resource?.pullRequest?.repository?.id ||
                payload?.resource?.repository?.id,
            name:
                payload?.resource?.pullRequest?.repository?.name ||
                payload?.resource?.repository?.name,
        } as any;

        const mappedPlatform = getMappedPlatform(PlatformType.AZURE_REPOS);
        if (!mappedPlatform) {
            return;
        }

        const context = await this.webhookContextService.getContext(
            PlatformType.AZURE_REPOS,
            String(repository.id),
        );

        try {
            // Extract comment data
            const commentContent = payload?.resource?.comment?.content;
            const isPullRequestActive =
                payload?.resource?.pullRequest?.status === 'active';

            if (!commentContent || !isPullRequestActive) {
                this.logger.debug({
                    message:
                        'Comment content empty or pull request not active, skipping.',
                    serviceName: AzureReposPullRequestHandler.name,
                    metadata: {
                        prId,
                        repository,
                        hasComment: !!commentContent,
                        isPullRequestActive,
                    },
                    context: AzureReposPullRequestHandler.name,
                });
                return;
            }

            if (!mappedPlatform) {
                this.logger.error({
                    message: 'Could not get mapped platform for Azure Repos.',
                    serviceName: AzureReposPullRequestHandler.name,
                    metadata: {
                        prId,
                    },
                    context: AzureReposPullRequestHandler.name,
                });
                return;
            }

            const comment = mappedPlatform.mapComment({ payload });

            if (!comment || !comment.body || payload?.action === 'deleted') {
                this.logger.debug({
                    message:
                        'Comment body empty or action is deleted, skipping.',
                    serviceName: AzureReposPullRequestHandler.name,
                    metadata: {
                        prId,
                    },
                    context: AzureReposPullRequestHandler.name,
                });
                return;
            }

            const isStartCommand = isReviewCommand(comment.body);
            const hasMarker = hasReviewMarker(comment.body);

            if (isStartCommand && !hasMarker) {
                this.logger.log({
                    message: `@kody start command detected in Azure Repos comment for PR#${prId}`,
                    serviceName: AzureReposPullRequestHandler.name,
                    metadata: {
                        prId,
                        repository,
                    },
                    context: AzureReposPullRequestHandler.name,
                });

                // Prepare params for the use cases
                const updatedParams = {
                    ...params,
                    payload: {
                        ...payload,
                        action: 'synchronize',
                        origin: 'command',
                        triggerCommentId: comment?.id,
                    },
                };

                // Execute the necessary use cases
                await this.savePullRequestUseCase.execute(updatedParams);
                if (context.organizationAndTeamData) {
                    await this.enqueueCodeReviewJobUseCase.execute({
                        codeManagementPayload: updatedParams.payload,
                        event: updatedParams.event,
                        platformType: PlatformType.AZURE_REPOS,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        correlationId: params.correlationId,
                        teamAutomationId: context.teamAutomationId,
                    });
                }
            }

            // For pull_request_review_comment that is not a start-review command
            if (
                !hasMarker &&
                !isStartCommand &&
                isKodyMentionNonReview(comment.body)
            ) {
                this.chatWithKodyFromGitUseCase.execute(params);
                return;
            }
        } catch (error) {
            this.logger.error({
                context: AzureReposPullRequestHandler.name,
                serviceName: AzureReposPullRequestHandler.name,
                metadata: {
                    prId,
                    repository,
                },
                message: `Error processing Azure Repos comment: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    /**
     * Checks if a webhook request is a duplicate
     * @param payload The webhook payload
     * @returns true if it's a duplicate request, false otherwise
     */
    private async isDuplicateRequest(payload: any): Promise<boolean> {
        const prId = payload?.resource?.pullRequestId;
        const eventType = payload?.eventType;

        if (!prId || !eventType) {
            return false;
        }

        // Use the complete payload for comparison
        const payloadHash = createHash('md5')
            .update(
                JSON.stringify({
                    prId,
                    eventType,
                    createdDate: payload?.createdDate,
                    id: payload?.id,
                }),
            )
            .digest('hex');

        // Unique cache key based on content
        const cacheKey = `azure_webhook:${prId}:${payloadHash}`;

        const exists = await this.cacheService.cacheExists(cacheKey);
        if (exists) {
            this.logger.warn({
                message: `Duplicate request detected`,
                context: AzureReposPullRequestHandler.name,
                serviceName: AzureReposPullRequestHandler.name,
                metadata: { prId, eventType, payloadHash },
            });
            return true;
        }

        await this.cacheService.addToCache(cacheKey, true, 60000); // 1 minute
        return false;
    }
}
