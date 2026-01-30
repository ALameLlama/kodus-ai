import { AzureReposPullRequestHandler } from './azureReposPullRequest.handler';
import { Test, TestingModule } from '@nestjs/testing';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import { CacheService } from '@libs/core/cache/cache.service';
import { GenerateIssuesFromPrClosedUseCase } from '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';

describe('AzureReposPullRequestHandler', () => {
    let handler: AzureReposPullRequestHandler;
    let pullRequestsService: any;
    let webhookContextService: any;

    beforeEach(async () => {
        pullRequestsService = {
            findByNumberAndRepositoryName: jest.fn(),
        };
        webhookContextService = {
            getContext: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AzureReposPullRequestHandler,
                { provide: SavePullRequestUseCase, useValue: {} },
                {
                    provide: WebhookContextService,
                    useValue: webhookContextService,
                },
                { provide: ChatWithKodyFromGitUseCase, useValue: {} },
                { provide: CacheService, useValue: {} },
                { provide: GenerateIssuesFromPrClosedUseCase, useValue: {} },
                { provide: EventEmitter2, useValue: {} },
                { provide: CodeManagementService, useValue: {} },
                { provide: EnqueueCodeReviewJobUseCase, useValue: {} },
                { provide: EnqueueImplementationCheckUseCase, useValue: {} },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: pullRequestsService,
                },
            ],
        }).compile();

        handler = module.get<AzureReposPullRequestHandler>(
            AzureReposPullRequestHandler,
        );
    });

    it('should be defined', () => {
        expect(handler).toBeDefined();
    });

    describe('shouldTriggerCodeReview', () => {
        it('should return true if event is not git.pullrequest.updated', async () => {
            const params = { event: 'git.pullrequest.created' } as any;
            const result = await (handler as any).shouldTriggerCodeReview(
                params,
                {},
            );
            expect(result).toBe(true);
        });

        it('should return true if draft status changed from true to false', async () => {
            const params = {
                event: 'git.pullrequest.updated',
                payload: {
                    resource: {
                        pullRequestId: 123,
                        repository: { name: 'repo' },
                        isDraft: false,
                    },
                },
            } as any;
            const context = { organizationAndTeamData: {} };
            pullRequestsService.findByNumberAndRepositoryName.mockResolvedValue(
                { isDraft: true },
            );

            const result = await (handler as any).shouldTriggerCodeReview(
                params,
                context,
            );
            expect(result).toBe(true);
        });

        it('should return false if commit hash is in stored commits', async () => {
            const params = {
                event: 'git.pullrequest.updated',
                payload: {
                    resource: {
                        pullRequestId: 123,
                        repository: { name: 'repo' },
                        lastMergeSourceCommit: { commitId: 'sha-new' },
                    },
                },
            } as any;
            const context = { organizationAndTeamData: {} };
            pullRequestsService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    commits: [{ sha: 'sha-old' }, { sha: 'sha-new' }],
                },
            );

            const result = await (handler as any).shouldTriggerCodeReview(
                params,
                context,
            );
            expect(result).toBe(false);
        });

        it('should return true if commit hash is NOT in stored commits', async () => {
            const params = {
                event: 'git.pullrequest.updated',
                payload: {
                    resource: {
                        pullRequestId: 123,
                        repository: { name: 'repo' },
                        lastMergeSourceCommit: { commitId: 'sha-new' },
                    },
                },
            } as any;
            const context = { organizationAndTeamData: {} };
            pullRequestsService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    commits: [{ sha: 'sha-old' }],
                },
            );

            const result = await (handler as any).shouldTriggerCodeReview(
                params,
                context,
            );
            expect(result).toBe(true);
        });

        it('should return false if status is completed', async () => {
            const params = {
                event: 'git.pullrequest.updated',
                payload: {
                    resource: {
                        pullRequestId: 123,
                        repository: { name: 'repo' },
                        status: 'completed',
                    },
                },
            } as any;
            const context = { organizationAndTeamData: {} };
            pullRequestsService.findByNumberAndRepositoryName.mockResolvedValue(
                {},
            );

            const result = await (handler as any).shouldTriggerCodeReview(
                params,
                context,
            );
            expect(result).toBe(false);
        });

        it('should return false if status is abandoned', async () => {
            const params = {
                event: 'git.pullrequest.updated',
                payload: {
                    resource: {
                        pullRequestId: 123,
                        repository: { name: 'repo' },
                        status: 'abandoned',
                    },
                },
            } as any;
            const context = { organizationAndTeamData: {} };
            pullRequestsService.findByNumberAndRepositoryName.mockResolvedValue(
                {},
            );

            const result = await (handler as any).shouldTriggerCodeReview(
                params,
                context,
            );
            expect(result).toBe(false);
        });
    });
});
