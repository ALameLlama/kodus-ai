import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';

import { stripCurlyBracesFromUUIDs } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@libs/automation/domain/automationExecution/contracts/execute.automation.service.contracts';
import { PlatformType } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';

import { Inject, Injectable } from '@nestjs/common';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import { createLogger } from '@kodus/flow';
import { EnqueueCodeReviewJobInput } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';

@Injectable()
export class RunCodeReviewAutomationUseCase implements IUseCase {
    private logger = createLogger(RunCodeReviewAutomationUseCase.name);

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        private readonly codeManagementService: CodeManagementService,

        private readonly webhookContextService: WebhookContextService,
    ) {}

    async execute(params: EnqueueCodeReviewJobInput) {
        try {
            const {
                codeManagementPayload: payload,
                event,
                platformType,
                teamAutomationId,
                organizationAndTeamData,
            } = params;

            if (!this.shouldRunAutomation(payload, platformType)) {
                return;
            }

            const mappedPlatform = getMappedPlatform(platformType);
            if (!mappedPlatform) {
                return;
            }

            const sanitizedPayload =
                platformType === PlatformType.BITBUCKET
                    ? stripCurlyBracesFromUUIDs(payload)
                    : payload;

            const action = mappedPlatform.mapAction({
                payload: sanitizedPayload,
                event: event,
            });

            if (!action) {
                return;
            }

            const repository = mappedPlatform.mapRepository({
                payload: sanitizedPayload,
            });

            if (!repository) {
                return;
            }

            const mappedUsers = mappedPlatform.mapUsers({
                payload: sanitizedPayload,
            });

            let pullRequestData = null;
            const pullRequest = mappedPlatform.mapPullRequest({
                payload: sanitizedPayload,
            });

            if (!pullRequest) {
                if (platformType === PlatformType.GITHUB) {
                    pullRequestData =
                        await this.codeManagementService.getPullRequest({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                            prNumber: sanitizedPayload?.issue?.number,
                        });
                }

                if (!pullRequestData) {
                    return;
                }

                // adjust it so it looks like the output from mapped platform
                const apiPullRequest = pullRequestData;
                pullRequestData = {
                    ...apiPullRequest,
                    repository: {
                        id: repository.id,
                        name: repository.name,
                    },
                    head: {
                        ref: apiPullRequest?.head?.ref,
                        sha: apiPullRequest?.head?.sha,
                        repo: {
                            fullName: apiPullRequest?.head?.repo?.fullName,
                        },
                    },
                    base: {
                        ref: apiPullRequest?.base?.ref,
                        sha: apiPullRequest?.base?.sha,
                        repo: {
                            fullName: apiPullRequest?.base?.repo?.fullName,
                            defaultBranch:
                                apiPullRequest?.base?.repo?.defaultBranch,
                        },
                    },
                    title: apiPullRequest?.title,
                    body: apiPullRequest?.body,
                    user: {
                        id: apiPullRequest?.user?.id,
                        login: apiPullRequest?.user?.login,
                        name: apiPullRequest?.user?.name,
                    },
                    isDraft:
                        apiPullRequest?.isDraft ??
                        apiPullRequest?.draft ??
                        false,
                };
            }

            pullRequestData = pullRequestData ?? pullRequest;

            let repositoryData = repository;
            // Only github provides the language in the webhook, so for the others try to get it
            if (
                !repositoryData.language &&
                platformType !== PlatformType.GITHUB
            ) {
                repositoryData = {
                    ...repository,
                    language:
                        await this.codeManagementService.getLanguageRepository({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                        }),
                };
            }

            this.logger.log({
                message: `RunCodeReviewAutomationUseCase PR#${pullRequestData?.number}`,
                context: RunCodeReviewAutomationUseCase.name,
                metadata: {
                    organizationAndTeamData,
                    repository: repositoryData,
                    pullRequest: pullRequestData,
                    branch: pullRequestData?.head?.ref,
                    codeManagementEvent: event,
                    platformType: platformType,
                    origin: sanitizedPayload?.origin,
                },
            });

            const userGitId =
                // in azure repos, the user id is the descriptor
                mappedUsers?.user?.descriptor?.toString() ||
                mappedUsers?.user?.id?.toString() ||
                mappedUsers?.user?.uuid?.toString();

            const strategyParams = {
                organizationAndTeamData,
                teamAutomationId: teamAutomationId,
                repository: repositoryData,
                pullRequest: pullRequestData,
                branch: pullRequestData?.head?.ref,
                codeManagementEvent: event,
                platformType: platformType,
                origin: sanitizedPayload?.origin,
                action,
                //TODO: prcisa do byokauu
                //byokConfig,
                triggerCommentId: sanitizedPayload?.triggerCommentId,
                userGitId,
            };

            const result = await this.executeAutomation.executeStrategy(
                AutomationType.AUTOMATION_CODE_REVIEW,
                strategyParams,
            );

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error executing code review automation',
                context: RunCodeReviewAutomationUseCase.name,
                error: error,
                metadata: {
                    correlationId: params.correlationId,
                    ...params.organizationAndTeamData,
                },
            });
        }
    }

    private shouldRunAutomation(payload: any, platformType: PlatformType) {
        const allowedActions = [
            'opened',
            'synchronize',
            'ready_for_review',
            'open',
            'update',
            'git.pullrequest.updated',
            'git.pullrequest.created',
        ];
        const currentAction =
            payload?.action ||
            payload?.object_attributes?.action ||
            payload?.eventType;

        const isMerged =
            payload?.object_attributes?.state === 'merged' ||
            payload?.resource?.pullRequest?.status === 'completed' ||
            payload?.resource?.status === 'completed' ||
            false;

        const isCommand = payload?.origin === 'command';

        // bitbucket has already been handled in the webhook validation
        if (
            !isCommand &&
            platformType !== PlatformType.BITBUCKET &&
            (!allowedActions.includes(currentAction) || isMerged)
        ) {
            this.logger.log({
                message: 'Automation skipped',
                context: RunCodeReviewAutomationUseCase.name,
                metadata: { currentAction, isMerged, platformType },
            });
            return false;
        }

        return true;
    }
}
