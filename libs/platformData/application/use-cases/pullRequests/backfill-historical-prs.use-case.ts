import { Injectable, Inject } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { IPullRequests } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { PullRequest } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

interface BackfillParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repositories: Array<{
        id: string;
        name: string;
        fullName?: string;
        url?: string;
    }>;
    startDate?: string;
    endDate?: string;
}

@Injectable()
export class BackfillHistoricalPRsUseCase {
    private readonly logger = createLogger(BackfillHistoricalPRsUseCase.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,
    ) {}

    public async execute(params: BackfillParams): Promise<void> {
        const { organizationAndTeamData, repositories, startDate, endDate } =
            params;

        const defaultStartDate =
            startDate ||
            new Date(
                new Date().setMonth(new Date().getMonth() - 2),
            ).toISOString();
        const defaultEndDate = endDate || new Date().toISOString();

        this.logger.log({
            message: 'Starting PR historical backfill',
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoriesCount: repositories.length,
                startDate: defaultStartDate,
                endDate: defaultEndDate,
            },
        });

        await Promise.all(
            repositories.map(async (repository) => {
                try {
                    await this.backfillRepositoryPRs(
                        organizationAndTeamData,
                        repository,
                        defaultStartDate,
                        defaultEndDate,
                    );
                } catch (error) {
                    this.logger.error({
                        message: `Error during backfill for repository ${repository.name}`,
                        context: BackfillHistoricalPRsUseCase.name,
                        error: error.message,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                            repositoryId: repository.id,
                            repositoryName: repository.name,
                        },
                    });
                }
            }),
        );

        this.logger.log({
            message: 'Completed PR historical backfill',
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoriesCount: repositories.length,
            },
        });
    }

    private async backfillRepositoryPRs(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string; fullName?: string; url?: string },
        startDate: string,
        endDate: string,
    ): Promise<void> {
        this.logger.log({
            message: `Fetching PRs for repository ${repository.name}`,
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                repositoryId: repository.id,
                repositoryName: repository.name,
                startDate,
                endDate,
            },
        });

        const pullRequests =
            await this.codeManagementService.getPullRequestsByRepository({
                organizationAndTeamData,
                repository: {
                    id: repository.id,
                    name: repository.name,
                },
                filters: {
                    startDate,
                    endDate,
                },
            });

        if (!pullRequests || pullRequests.length === 0) {
            this.logger.log({
                message: `No PRs found for repository ${repository.name}`,
                context: BackfillHistoricalPRsUseCase.name,
                metadata: {
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                },
            });
            return;
        }

        this.logger.log({
            message: `Found ${pullRequests.length} PRs for repository ${repository.name}`,
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                repositoryId: repository.id,
                repositoryName: repository.name,
                pullRequestsCount: pullRequests.length,
            },
        });

        let savedCount = 0;
        let skippedCount = 0;

        for (const pr of pullRequests) {
            try {
                const existingPR =
                    await this.pullRequestsRepository.findByNumberAndRepositoryId(
                        pr.number,
                        repository.id,
                        organizationAndTeamData,
                    );

                if (existingPR) {
                    skippedCount++;
                    continue;
                }

                let fileStats = {
                    totalAdded: 0,
                    totalDeleted: 0,
                    totalChanges: 0,
                };
                let commits = [];

                try {
                    const [files, prCommits] = await Promise.all([
                        this.codeManagementService.getFilesByPullRequestId({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                            prNumber: pr.number,
                        }),
                        this.codeManagementService.getCommitsForPullRequestForCodeReview(
                            {
                                organizationAndTeamData,
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                                prNumber: pr.number,
                            },
                        ),
                    ]);

                    if (files && files.length > 0) {
                        fileStats = {
                            totalAdded: files.reduce(
                                (sum, file) => sum + (file.additions || 0),
                                0,
                            ),
                            totalDeleted: files.reduce(
                                (sum, file) => sum + (file.deletions || 0),
                                0,
                            ),
                            totalChanges: files.reduce(
                                (sum, file) => sum + (file.changes || 0),
                                0,
                            ),
                        };
                    }

                    if (prCommits && prCommits.length > 0) {
                        commits = prCommits.map((commit) => ({
                            sha: commit.sha || '',
                            message: commit.message || '',
                            author: {
                                id: commit.author?.id || '',
                                username:
                                    commit.author?.username ||
                                    commit.author?.name ||
                                    '',
                                name: commit.author?.name || '',
                                email: commit.author?.email || '',
                                date:
                                    commit.created_at ||
                                    commit.author?.date ||
                                    new Date().toISOString(),
                            },
                            createdAt:
                                commit.created_at ||
                                commit.author?.date ||
                                new Date().toISOString(),
                        }));
                    }
                } catch (dataError) {
                    this.logger.warn({
                        message: `Could not fetch files/commits for PR #${pr.number}, using default values`,
                        context: BackfillHistoricalPRsUseCase.name,
                        metadata: {
                            repositoryName: repository.name,
                            prNumber: pr.number,
                            error: dataError.message,
                        },
                    });
                }

                const prDocument = this.transformPullRequestToDocument(
                    pr,
                    organizationAndTeamData.organizationId,
                    fileStats,
                    commits,
                    repository,
                );

                await this.pullRequestsRepository.create(prDocument);
                savedCount++;
            } catch (error) {
                this.logger.error({
                    message: `Error saving PR #${pr.number}`,
                    context: BackfillHistoricalPRsUseCase.name,
                    error: error.message,
                    metadata: {
                        repositoryName: repository.name,
                        prNumber: pr.number,
                    },
                });
            }
        }

        this.logger.log({
            message: `Completed backfill for repository ${repository.name}`,
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                repositoryId: repository.id,
                repositoryName: repository.name,
                savedCount,
                skippedCount,
                totalProcessed: pullRequests.length,
            },
        });
    }

    private transformPullRequestToDocument(
        pr: PullRequest,
        organizationId: string,
        fileStats: {
            totalAdded: number;
            totalDeleted: number;
            totalChanges: number;
        },
        commits: any[],
        repository: { id: string; name: string; fullName?: string; url?: string },
    ): Omit<IPullRequests, 'uuid'> {
        const isMerged = !!pr.merged_at;
        const repoData = pr.head?.repo || pr.base?.repo;

        return {
            title: pr.title || '',
            status: pr.state || 'unknown',
            merged: isMerged,
            number: pr.number,
            url: pr.prURL || '',
            baseBranchRef: pr.base?.ref || pr.targetRefName || '',
            headBranchRef: pr.head?.ref || pr.sourceRefName || '',
            repository: {
                id:
                    repoData?.id ||
                    pr.repositoryData?.id ||
                    pr.repositoryId ||
                    '',
                name: repoData?.name || pr.repositoryData?.name || '',
                fullName: repoData?.fullName || repository.fullName || '',
                language: '',
                url: repository.url || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            openedAt: pr.created_at || new Date().toISOString(),
            closedAt: pr.closed_at || '',
            files: [],
            totalAdded: fileStats.totalAdded,
            totalDeleted: fileStats.totalDeleted,
            totalChanges: fileStats.totalChanges,
            createdAt: pr.created_at || new Date().toISOString(),
            updatedAt: pr.updated_at || new Date().toISOString(),
            provider: '',
            user: {
                id: pr.user?.id || '',
                username: pr.user?.login || pr.user?.name || '',
            },
            reviewers:
                pr.reviewers?.map((reviewer) => ({
                    id: String(reviewer.id) || '',
                    username: '',
                })) || [],
            assignees:
                pr.participants?.map((participant) => ({
                    id: String(participant.id) || '',
                    username: '',
                })) || [],
            organizationId,
            commits,
            syncedEmbeddedSuggestions: false,
            syncedWithIssues: false,
            isDraft: pr.isDraft || false,
        };
    }
}
