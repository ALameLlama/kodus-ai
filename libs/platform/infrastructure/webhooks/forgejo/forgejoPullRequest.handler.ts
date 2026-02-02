import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { GenerateIssuesFromPrClosedUseCase } from '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import {
    IWebhookEventHandler,
    IWebhookEventParams,
} from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import {
    hasReviewMarker,
    isKodyMentionNonReview,
    isReviewCommand,
} from '@libs/common/utils/codeManagement/codeCommentMarkers';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import {
    WebhookForgejoPullRequestAction,
    IWebhookForgejoPullRequestEvent,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';

/**
 * Handler for Forgejo/Gitea webhook events.
 * Processes both pull request and comment events.
 */
@Injectable()
export class ForgejoPullRequestHandler implements IWebhookEventHandler {
    private readonly logger = createLogger(ForgejoPullRequestHandler.name);

    constructor(
        private readonly savePullRequestUseCase: SavePullRequestUseCase,
        private readonly webhookContextService: WebhookContextService,
        private readonly chatWithKodyFromGitUseCase: ChatWithKodyFromGitUseCase,
        private readonly generateIssuesFromPrClosedUseCase: GenerateIssuesFromPrClosedUseCase,
        private readonly eventEmitter: EventEmitter2,
        private readonly codeManagement: CodeManagementService,
        private readonly enqueueCodeReviewJobUseCase: EnqueueCodeReviewJobUseCase,
        private readonly enqueueImplementationCheckUseCase: EnqueueImplementationCheckUseCase,
    ) {}

    /**
     * Checks if this handler can process the given webhook event.
     * @param params The webhook event parameters.
     * @returns True if this handler can process the event, false otherwise.
     */
    public canHandle(params: IWebhookEventParams): boolean {
        return (
            params.platformType === PlatformType.FORGEJO &&
            ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(params.event)
        );
    }

    /**
     * Processes Forgejo webhook events.
     * @param params The webhook event parameters.
     */
    public async execute(params: IWebhookEventParams): Promise<void> {
        const { event } = params;

        switch (event) {
            case 'pull_request':
                await this.handlePullRequest(params);
                break;
            case 'issue_comment':
                await this.handleIssueComment(params);
                break;
            case 'pull_request_review':
            case 'pull_request_review_comment':
                // For now, we'll handle review events minimally
                this.logger.log({
                    message: `Received Forgejo ${event} event, processing...`,
                    context: ForgejoPullRequestHandler.name,
                });
                break;
            default:
                this.logger.warn({
                    message: `Unsupported Forgejo event: ${event}`,
                    context: ForgejoPullRequestHandler.name,
                });
        }
    }

    private async handlePullRequest(params: IWebhookEventParams): Promise<void> {
        const { payload, event } = params;
        const prNumber = payload?.pull_request?.number || payload?.number;
        const prUrl = payload?.pull_request?.html_url;

        this.logger.log({
            context: ForgejoPullRequestHandler.name,
            serviceName: ForgejoPullRequestHandler.name,
            message: `Processing Forgejo 'pull_request' event for PR #${prNumber} (${prUrl || 'URL not found'})`,
            metadata: { prNumber, prUrl, action: payload?.action },
        });

        // Use full_name as name to match how repos are stored in config (e.g., "Llama/testing_repo")
        // This ensures consistency with saved repository config and allows simple owner/repo extraction
        const repository = {
            id: String(payload?.repository?.id),
            name: payload?.repository?.full_name || payload?.repository?.name,
        };

        const mappedPlatform = getMappedPlatform(PlatformType.FORGEJO);
        if (!mappedPlatform) {
            this.logger.error({
                message: 'Could not get mapped platform for Forgejo.',
                serviceName: ForgejoPullRequestHandler.name,
                metadata: { prNumber },
                context: ForgejoPullRequestHandler.name,
            });
            return;
        }

        const context = await this.webhookContextService.getContext(
            PlatformType.FORGEJO,
            String(payload?.repository?.id),
        );

        this.logger.log({
            message: `Webhook context lookup result`,
            context: ForgejoPullRequestHandler.name,
            metadata: {
                repositoryId: String(payload?.repository?.id),
                hasContext: !!context,
                hasOrgTeamData: !!context?.organizationAndTeamData,
                teamAutomationId: context?.teamAutomationId,
            },
        });

        // If no active automation found, complete the webhook processing immediately
        if (!context?.organizationAndTeamData) {
            this.logger.log({
                message: `No active automation found for repository, completing webhook processing`,
                context: ForgejoPullRequestHandler.name,
                metadata: {
                    prNumber,
                    repositoryId: String(payload?.repository?.id),
                    repositoryName: repository.name,
                },
            });
            return;
        }

        try {
            // Check if we should trigger code review based on the PR action
            const shouldTrigger = this.shouldTriggerCodeReview(payload);
            this.logger.log({
                message: `Checking if should trigger code review`,
                context: ForgejoPullRequestHandler.name,
                metadata: {
                    action: payload?.action,
                    shouldTrigger,
                    prNumber,
                    isDraft: payload?.pull_request?.draft,
                    isMerged: payload?.pull_request?.merged,
                },
            });

            if (shouldTrigger) {
                await this.savePullRequestUseCase.execute(params);

                if (this.enqueueCodeReviewJobUseCase && context.organizationAndTeamData) {
                    this.logger.log({
                        message: 'About to enqueue code review job',
                        context: ForgejoPullRequestHandler.name,
                        metadata: { prNumber, teamAutomationId: context.teamAutomationId },
                    });
                    
                    this.enqueueCodeReviewJobUseCase
                        .execute({
                            codeManagementPayload: payload,
                            event: params.event,
                            platformType: PlatformType.FORGEJO,
                            organizationAndTeamData: context.organizationAndTeamData,
                            correlationId: params.correlationId,
                            teamAutomationId: context.teamAutomationId,
                        })
                        .then((jobId) => {
                            this.logger.log({
                                message: 'Code review job enqueued for asynchronous processing',
                                context: ForgejoPullRequestHandler.name,
                                metadata: {
                                    jobId,
                                    prNumber,
                                    repositoryId: repository.id,
                                },
                            });
                        })
                        .catch((error) => {
                            this.logger.error({
                                message: 'Failed to enqueue code review job',
                                context: ForgejoPullRequestHandler.name,
                                error,
                                metadata: {
                                    prNumber,
                                    repositoryId: repository.id,
                                },
                            });
                        });
                }

                // Check for new commits (synchronized action)
                if (payload?.action === WebhookForgejoPullRequestAction.SYNCHRONIZED) {
                    if (context.organizationAndTeamData) {
                        this.enqueueImplementationCheckUseCase
                            .execute({
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                                pullRequestNumber: prNumber,
                                commitSha: payload?.pull_request?.head?.sha,
                                trigger: payload?.action,
                                payload: payload,
                                event: event,
                                organizationAndTeamData: context.organizationAndTeamData,
                                platformType: PlatformType.FORGEJO,
                            })
                            .catch((e) => {
                                this.logger.error({
                                    message: 'Failed to enqueue implementation check',
                                    context: ForgejoPullRequestHandler.name,
                                    error: e,
                                    metadata: {
                                        repository,
                                        pullRequestNumber: prNumber,
                                    },
                                });
                            });
                    }
                }

                // Handle PR merge/close events
                if (
                    payload?.action === WebhookForgejoPullRequestAction.CLOSED &&
                    payload?.pull_request?.merged
                ) {
                    this.generateIssuesFromPrClosedUseCase.execute(params);

                    try {
                        if (context.organizationAndTeamData) {
                            const baseRef = payload?.pull_request?.base?.ref;
                            const defaultBranch = await this.codeManagement.getDefaultBranch({
                                organizationAndTeamData: context.organizationAndTeamData,
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                            });

                            if (baseRef !== defaultBranch) {
                                return;
                            }

                            const changedFiles = await this.codeManagement.getFilesByPullRequestId({
                                organizationAndTeamData: context.organizationAndTeamData,
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                                prNumber,
                            });

                            this.eventEmitter.emit(
                                'pull-request.closed',
                                new PullRequestClosedEvent(
                                    context.organizationAndTeamData,
                                    repository,
                                    prNumber,
                                    changedFiles || [],
                                ),
                            );
                        }
                    } catch (e) {
                        this.logger.error({
                            message: 'Failed to sync Kody Rules after PR merge',
                            context: ForgejoPullRequestHandler.name,
                            error: e,
                        });
                    }
                }

                return;
            } else if (
                payload?.action === WebhookForgejoPullRequestAction.CLOSED ||
                payload?.action === WebhookForgejoPullRequestAction.EDITED
            ) {
                // For closed or edited PRs, just save the state without triggering automation
                await this.savePullRequestUseCase.execute(params);

                if (
                    payload?.action === WebhookForgejoPullRequestAction.CLOSED &&
                    payload?.pull_request?.merged
                ) {
                    this.generateIssuesFromPrClosedUseCase
                        .execute(params)
                        .catch((error) => {
                            this.logger.error({
                                message: 'Failed to generate issues from merged PR',
                                context: ForgejoPullRequestHandler.name,
                                error,
                                metadata: {
                                    prNumber,
                                    repositoryId: repository.id,
                                },
                            });
                        });
                }

                return;
            }
        } catch (error) {
            this.logger.error({
                context: ForgejoPullRequestHandler.name,
                serviceName: ForgejoPullRequestHandler.name,
                metadata: {
                    prNumber,
                    prUrl,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                message: `Error processing Forgejo pull request #${prNumber}: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    /**
     * Processes Forgejo issue comment events (used for PR comments)
     */
    private async handleIssueComment(params: IWebhookEventParams): Promise<void> {
        const { payload } = params;
        const issueNumber = payload?.issue?.number;

        // Only process comments on pull requests
        if (!payload?.is_pull) {
            return;
        }

        const mappedPlatform = getMappedPlatform(PlatformType.FORGEJO);
        if (!mappedPlatform) {
            this.logger.error({
                message: 'Could not get mapped platform for Forgejo.',
                serviceName: ForgejoPullRequestHandler.name,
                metadata: { issueNumber },
                context: ForgejoPullRequestHandler.name,
            });
            return;
        }

        const context = await this.webhookContextService.getContext(
            PlatformType.FORGEJO,
            String(payload?.repository?.id),
        );

        try {
            // Only process created comments
            if (payload?.action === 'created') {
                const comment = mappedPlatform.mapComment({ payload });
                if (!comment || !comment.body) {
                    this.logger.debug({
                        message: 'Comment body empty, skipping.',
                        serviceName: ForgejoPullRequestHandler.name,
                        metadata: { issueNumber },
                        context: ForgejoPullRequestHandler.name,
                    });
                    return;
                }

                const isStartCommand = isReviewCommand(comment.body);
                const hasMarker = hasReviewMarker(comment.body);

                if (isStartCommand && !hasMarker) {
                    this.logger.log({
                        message: `@kody start command detected in Forgejo comment for PR#${issueNumber}`,
                        serviceName: ForgejoPullRequestHandler.name,
                        metadata: { issueNumber },
                        context: ForgejoPullRequestHandler.name,
                    });

                    // Prepare params for use cases
                    const updatedParams = {
                        ...params,
                        payload: {
                            ...payload,
                            action: 'synchronize',
                            origin: 'command',
                            triggerCommentId: comment?.id,
                        },
                    };

                    await this.savePullRequestUseCase.execute(updatedParams);
                    if (context.organizationAndTeamData) {
                        await this.enqueueCodeReviewJobUseCase.execute({
                            codeManagementPayload: updatedParams.payload,
                            event: updatedParams.event,
                            platformType: PlatformType.FORGEJO,
                            organizationAndTeamData: context.organizationAndTeamData,
                            correlationId: params.correlationId,
                            teamAutomationId: context.teamAutomationId,
                        });
                    }
                    return;
                }

                if (!isStartCommand && !hasMarker && isKodyMentionNonReview(comment.body)) {
                    this.chatWithKodyFromGitUseCase.execute(params);
                    return;
                }
            }
        } catch (error) {
            this.logger.error({
                context: ForgejoPullRequestHandler.name,
                serviceName: ForgejoPullRequestHandler.name,
                metadata: { issueNumber },
                message: `Error processing Forgejo comment: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    private shouldTriggerCodeReview(payload: IWebhookForgejoPullRequestEvent): boolean {
        const action = payload?.action;
        const pullRequest = payload?.pull_request;

        // Trigger on new PR
        if (action === WebhookForgejoPullRequestAction.OPENED) {
            return true;
        }

        // Trigger on new commits (synchronized)
        if (action === WebhookForgejoPullRequestAction.SYNCHRONIZED) {
            return true;
        }

        // Trigger on reopened
        if (action === WebhookForgejoPullRequestAction.REOPENED) {
            return true;
        }

        // Trigger on merge
        if (action === WebhookForgejoPullRequestAction.CLOSED && pullRequest?.merged) {
            return true;
        }

        // Trigger on close (not merged)
        if (action === WebhookForgejoPullRequestAction.CLOSED && !pullRequest?.merged) {
            return true;
        }

        return false;
    }
}
