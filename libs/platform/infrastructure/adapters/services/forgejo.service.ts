import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

import { CacheService } from '@libs/core/cache/cache.service';
import {
    CreateAuthIntegrationStatus,
    IntegrationCategory,
    IntegrationConfigKey,
    LanguageValue,
    PlatformType,
    PullRequestState,
} from '@libs/core/domain/enums';
import {
    Repository,
    ReviewComment,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { IntegrationServiceDecorator } from '@libs/common/utils/decorators/integration-service.decorator';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';

import { GitCloneParams } from '@libs/platform/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import {
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestWithFiles,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { ForgejoAuthDetail } from '@libs/integrations/domain/authIntegrations/types/forgejo-auth-detail.type';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementConnectionStatus } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';
import { getSeverityLevelShield } from '@libs/common/utils/codeManagement/severityLevel';
import { getCodeReviewBadge } from '@libs/common/utils/codeManagement/codeReviewBadge';
import { getLabelShield } from '@libs/common/utils/codeManagement/labels';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { createLogger } from '@kodus/flow';
import { hasKodyMarker } from '@libs/common/utils/codeManagement/codeCommentMarkers';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@libs/common/utils/glob-utils';
import { extractOwnerAndRepo } from '@libs/common/utils/helpers';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@libs/common/utils/translations/translations';

@Injectable()
@IntegrationServiceDecorator(PlatformType.FORGEJO, 'codeManagement')
export class ForgejoService implements Omit<
    ICodeManagementService,
    | 'getOrganizations'
    | 'getPullRequestsWithChangesRequested'
    | 'getListOfValidReviews'
    | 'getPullRequestReviewThreads'
    | 'getAuthenticationOAuthToken'
    | 'getCommitsByReleaseMode'
    | 'getDataForCalculateDeployFrequency'
    | 'requestChangesPullRequest'
> {
    private readonly logger = createLogger(ForgejoService.name);

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        private readonly configService: ConfigService,
        private readonly cacheService: CacheService,
        private readonly mcpManagerService?: MCPManagerService,
    ) { }

    private createApiClient(authDetail: ForgejoAuthDetail): AxiosInstance {
        const token = decrypt(authDetail.accessToken);
        const client = axios.create({
            baseURL: `${authDetail.host}/api/v1`,
            headers: {
                'Authorization': `token ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });

        // Add response interceptor for better error logging
        client.interceptors.response.use(
            (response) => response,
            (error) => {
                const status = error?.response?.status;
                const statusText = error?.response?.statusText;
                const url = error?.config?.url;
                const method = error?.config?.method?.toUpperCase();
                const errorMessage =
                    error?.response?.data?.message || error?.message;

                // Log specific error types for easier debugging
                if (status === 401) {
                    this.logger.error({
                        message: `Forgejo API authentication failed - check if token is valid and has required permissions`,
                        context: ForgejoService.name,
                        metadata: {
                            status,
                            statusText,
                            method,
                            url,
                            host: authDetail.host,
                            errorMessage,
                        },
                    });
                } else if (status === 403) {
                    this.logger.error({
                        message: `Forgejo API forbidden - token lacks permission for this operation`,
                        context: ForgejoService.name,
                        metadata: {
                            status,
                            statusText,
                            method,
                            url,
                            host: authDetail.host,
                            errorMessage,
                        },
                    });
                } else if (status === 404) {
                    this.logger.warn({
                        message: `Forgejo API resource not found`,
                        context: ForgejoService.name,
                        metadata: {
                            status,
                            method,
                            url,
                            errorMessage,
                        },
                    });
                } else if (
                    error.code === 'ECONNREFUSED' ||
                    error.code === 'ENOTFOUND'
                ) {
                    this.logger.error({
                        message: `Forgejo API connection failed - check if host is reachable`,
                        context: ForgejoService.name,
                        metadata: {
                            host: authDetail.host,
                            errorCode: error.code,
                            errorMessage,
                        },
                    });
                } else if (
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ECONNABORTED'
                ) {
                    this.logger.error({
                        message: `Forgejo API request timed out`,
                        context: ForgejoService.name,
                        metadata: {
                            host: authDetail.host,
                            method,
                            url,
                            errorCode: error.code,
                        },
                    });
                }

                return Promise.reject(error);
            },
        );

        return client;
    }

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        determineBots?: boolean;
    }): Promise<PullRequestAuthor[]> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return [];
            }

            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!authDetail || !repositories) {
                return [];
            }

            const api = this.createApiClient(authDetail);
            const since = new Date();
            since.setDate(since.getDate() - 60);

            const authorsSet = new Set<string>();
            const authorsData = new Map<string, PullRequestAuthor>();

            // TODO: should this be full_name?
            for (const repo of repositories) {
                try {
                    const [owner, repoName] = repo.name.split('/');
                    const response = await api.get(
                        `/repos/${owner}/${repoName}/pulls`,
                        {
                            params: {
                                state: 'all',
                                sort: 'created',
                                direction: 'desc',
                            },
                        },
                    );

                    for (const pr of response.data || []) {
                        if (pr.user?.id) {
                            const userId = pr.user.id.toString();
                            if (!authorsSet.has(userId)) {
                                authorsSet.add(userId);
                                authorsData.set(userId, {
                                    id: userId,
                                    name:
                                        pr.user.full_name ||
                                        pr.user.login ||
                                        pr.user.username,
                                    type: 'user',
                                });
                            }
                        }
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error fetching PR authors for repository',
                        context: ForgejoService.name,
                        error,
                        metadata: { repositoryId: repo.id },
                    });
                }
            }

            return Array.from(authorsData.values()).sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } catch (err) {
            this.logger.error({
                message: 'Error in getPullRequestAuthors',
                context: ForgejoService.name,
                error: err,
            });
            return [];
        }
    }

    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                throw new Error('Forgejo authentication details not found');
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getPullRequest',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}`,
            );

            // TODO: type this with pull request
            const pr = response.data;

            if (!pr) {
                return null;
            }

            return {
                number: pr.number,
                title: pr.title,
                body: pr.body,
                state: pr.state,
                created_at: pr.created_at,
                updated_at: pr.updated_at,
                merged_at: pr.merged_at,
                head: {
                    ref: pr.head?.ref,
                    sha: pr.head?.sha,
                    repo: {
                        name: pr.head?.repo?.name,
                        id: pr.head?.repo?.id?.toString(),
                    },
                },
                base: {
                    ref: pr.base?.ref,
                    sha: pr.base?.sha,
                    repo: {
                        name: pr.base?.repo?.name,
                        id: params.repository.id,
                    },
                },
                user: {
                    login: pr.user?.login || pr.user?.username,
                    id: pr.user?.id,
                },
                assignees: pr.assignees || [],
                reviewers: pr.requested_reviewers || [],
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull request by number from Forgejo',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            if (!integration) {
                return;
            }

            await this.integrationConfigService.createOrUpdateConfig(
                params.configKey,
                params.configValue,
                integration?.uuid,
                params.organizationAndTeamData,
                params.type,
            );

            this.createPullRequestWebhook({
                organizationAndTeamData: params.organizationAndTeamData,
            });
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async createAuthIntegration(
        params: any,
    ): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            // Forgejo only supports token authentication (no OAuth)
            const res = await this.authenticateWithToken(params);

            this.mcpManagerService?.createKodusMCPIntegration(
                params.organizationAndTeamData.organizationId,
            );

            return res;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async authenticateWithToken(params: any): Promise<any> {
        try {
            const { token, host } = params;

            this.logger.log({
                message: 'Starting Forgejo token authentication',
                context: ForgejoService.name,
                metadata: {
                    host,
                    hasToken: !!token,
                    tokenLength: token?.length,
                },
            });

            if (!host) {
                throw new Error('Forgejo host URL is required');
            }

            if (!token) {
                throw new Error('Forgejo access token is required');
            }

            // Normalize host URL (remove trailing slash)
            const normalizedHost = host.replace(/\/+$/, '');

            this.logger.log({
                message: 'Testing Forgejo token with /api/v1/user endpoint',
                context: ForgejoService.name,
                metadata: { normalizedHost },
            });

            // Test the token by fetching user info
            const testResponse = await axios.get(
                `${normalizedHost}/api/v1/user`,
                {
                    headers: {
                        Authorization: `token ${token}`,
                    },
                    timeout: 30000,
                },
            );

            this.logger.log({
                message: 'Forgejo /api/v1/user response received',
                context: ForgejoService.name,
                metadata: {
                    status: testResponse?.status,
                    hasData: !!testResponse?.data,
                    username: testResponse?.data?.login,
                },
            });

            if (!testResponse || !testResponse.data) {
                throw new Error('Forgejo failed to validate the token.');
            }

            const authDetails: ForgejoAuthDetail = {
                accessToken: encrypt(token),
                authMode: AuthMode.TOKEN,
                host: normalizedHost,
            };

            const checkRepos = await this.checkRepositoryPermissions({
                authDetails,
            });
            if (!checkRepos.success) return checkRepos;

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            await this.handleIntegration(
                integration,
                authDetails,
                params.organizationAndTeamData,
            );

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            const errorMessage =
                err?.response?.data?.message || err?.message || 'Unknown error';
            const statusCode = err?.response?.status;

            this.logger.error({
                message: 'Error authenticating with Forgejo token',
                context: ForgejoService.name,
                error: err,
                metadata: {
                    errorMessage,
                    statusCode,
                    responseData: err?.response?.data,
                },
            });
            throw new BadRequestException(
                `Error authenticating with Forgejo token: ${errorMessage}`,
            );
        }
    }

    private async handleIntegration(
        integration: any,
        authDetails: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        if (!integration) {
            await this.addAccessToken(organizationAndTeamData, authDetails);
        } else {
            await this.updateAuthIntegration({
                organizationAndTeamData,
                authIntegrationId: integration?.authIntegration?.uuid,
                integrationId: integration?.uuid,
                authDetails,
            });
        }
    }

    private async checkRepositoryPermissions(params: {
        authDetails: ForgejoAuthDetail;
    }) {
        try {
            const { authDetails } = params;
            const api = this.createApiClient(authDetails);

            // Try to fetch user's repos first
            const userReposResponse = await api.get('/user/repos', {
                params: { limit: 50 },
            });

            if (userReposResponse.data && userReposResponse.data.length > 0) {
                return {
                    success: true,
                    status: CreateAuthIntegrationStatus.SUCCESS,
                };
            }

            // If no user repos, try to fetch repos from organizations the user belongs to
            const orgsResponse = await api.get('/user/orgs', {
                params: { limit: 50 },
            });

            for (const org of orgsResponse.data || []) {
                const orgReposResponse = await api.get(
                    `/orgs/${org.username}/repos`,
                    {
                        params: { limit: 10 },
                    },
                );

                if (orgReposResponse.data && orgReposResponse.data.length > 0) {
                    return {
                        success: true,
                        status: CreateAuthIntegrationStatus.SUCCESS,
                    };
                }
            }

            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to list repositories when creating integration',
                context: ForgejoService.name,
                error,
            });
            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        }
    }

    async updateAuthIntegration(params: any): Promise<any> {
        await this.integrationService.update(
            {
                uuid: params.integrationId,
                authIntegration: params.authIntegrationId,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
            { status: true },
        );

        return await this.authIntegrationService.update(
            {
                uuid: params.authIntegrationId,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
            {
                status: true,
                authDetails: params?.authDetails,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
        );
    }

    async getRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            archived?: boolean;
            organizationSelected?: string;
            visibility?: 'all' | 'public' | 'private';
            language?: string;
        };
        options?: {
            includePullRequestMetrics?: {
                lastNDays?: number;
            };
        };
    }): Promise<Repositories[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return [];
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            const api = this.createApiClient(authDetail);

            // Fetch user's repositories
            const userReposResponse = await api.get('/user/repos', {
                params: { limit: 100 },
            });

            const repositories: Repositories[] = [];
            const seenRepoIds = new Set<string>();

            // Add user repos
            for (const repo of userReposResponse.data || []) {
                const repoId = repo.id.toString();
                if (!seenRepoIds.has(repoId)) {
                    seenRepoIds.add(repoId);
                    repositories.push({
                        id: repoId,
                        name: repo.full_name,
                        http_url: repo.clone_url,
                        avatar_url: repo.avatar_url || repo.owner?.avatar_url,
                        organizationName:
                            repo.owner?.login || repo.owner?.username,
                        visibility: repo.private ? 'private' : 'public',
                        selected: integrationConfig?.configValue?.some(
                            (r: { name: string }) => r?.name === repo.full_name,
                        ),
                        default_branch: repo.default_branch,
                        lastActivityAt: repo.updated_at,
                    });
                }
            }

            // Fetch organizations the user belongs to
            try {
                const orgsResponse = await api.get('/user/orgs', {
                    params: { limit: 50 },
                });

                // Fetch repos from each organization
                for (const org of orgsResponse.data || []) {
                    try {
                        const orgReposResponse = await api.get(
                            `/orgs/${org.username}/repos`,
                            {
                                params: { limit: 100 },
                            },
                        );

                        for (const repo of orgReposResponse.data || []) {
                            const repoId = repo.id.toString();
                            if (!seenRepoIds.has(repoId)) {
                                seenRepoIds.add(repoId);
                                repositories.push({
                                    id: repoId,
                                    name: repo.full_name,
                                    http_url: repo.clone_url,
                                    avatar_url:
                                        repo.avatar_url ||
                                        repo.owner?.avatar_url,
                                    organizationName: org.username,
                                    visibility: repo.private
                                        ? 'private'
                                        : 'public',
                                    selected:
                                        integrationConfig?.configValue?.some(
                                            (r: { name: string }) =>
                                                r?.name === repo.full_name,
                                        ),
                                    default_branch: repo.default_branch,
                                    lastActivityAt: repo.updated_at,
                                });
                            }
                        }
                    } catch (orgError) {
                        this.logger.warn({
                            message: `Failed to fetch repos for org ${org.username}`,
                            context: ForgejoService.name,
                            error: orgError,
                        });
                    }
                }
            } catch (orgsError) {
                this.logger.warn({
                    message: 'Failed to fetch user organizations',
                    context: ForgejoService.name,
                    error: orgsError,
                });
            }

            return repositories;
        } catch (error) {
            this.logger.error({
                message: 'Failed to fetch Forgejo repositories',
                context: ForgejoService.name,
                error,
            });
            throw new BadRequestException(error);
        }
    }

    async getPullRequests(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id: string; name: string };
        filters?: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
        };
    }): Promise<PullRequest[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        try {
            if (!organizationAndTeamData.organizationId) {
                return [];
            }

            const authDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const allRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !authDetail ||
                !allRepositories ||
                allRepositories.length === 0
            ) {
                return [];
            }

            let reposToProcess = allRepositories;
            if (repository && (repository.name || repository.id)) {
                const foundRepo = allRepositories.find(
                    (r) => r.name === repository.name || r.id === repository.id,
                );
                if (!foundRepo) {
                    return [];
                }
                reposToProcess = [foundRepo];
            }

            const api = this.createApiClient(authDetail);
            const pullRequests: PullRequest[] = [];

            for (const repo of reposToProcess) {
                try {
                    const [owner, repoName] = repo.name.split('/');
                    const state = this.mapPullRequestState(filters.state);

                    const response = await api.get(
                        `/repos/${owner}/${repoName}/pulls`,
                        {
                            params: {
                                state,
                                sort: 'created',
                                direction: 'desc',
                            },
                        },
                    );

                    for (const pr of response.data || []) {
                        pullRequests.push(
                            this.transformPullRequest(
                                pr,
                                repo,
                                organizationAndTeamData,
                            ),
                        );
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error fetching PRs for repository',
                        context: ForgejoService.name,
                        error,
                        metadata: { repositoryId: repo.id },
                    });
                }
            }

            return pullRequests;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull requests from Forgejo',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    private mapPullRequestState(state?: PullRequestState): string {
        switch (state) {
            case PullRequestState.OPENED:
                return 'open';
            case PullRequestState.CLOSED:
                return 'closed';
            case PullRequestState.MERGED:
                return 'closed'; // Forgejo uses closed state for merged PRs
            default:
                return 'all';
        }
    }

    private transformPullRequest(
        pr: any,
        repo: Repositories,
        organizationAndTeamData: OrganizationAndTeamData,
    ): PullRequest {
        const state = pr.merged
            ? PullRequestState.MERGED
            : pr.state === 'open'
                ? PullRequestState.OPENED
                : PullRequestState.CLOSED;

        return {
            id: pr.id?.toString() ?? '',
            number: pr.number ?? -1,
            pull_number: pr.number ?? -1, // TODO: remove, legacy, use number
            organizationId: organizationAndTeamData?.organizationId ?? '',
            title: pr.title ?? '',
            body: pr.body ?? '',
            state,
            prURL: pr.html_url ?? '',
            repository: repo.name ?? '', // TODO: remove, legacy, use repositoryData
            repositoryId: repo.id ?? '', // TODO: remove, legacy, use repositoryData
            repositoryData: {
                id: repo.id ?? '',
                name: repo.name ?? '',
            },
            message: pr.title ?? '',
            created_at: pr.created_at ?? '',
            closed_at: pr.closed_at ?? '',
            updated_at: pr.updated_at ?? '',
            merged_at: pr.merged_at ?? '',
            participants: pr.user?.id ? [{ id: pr.user.id.toString() }] : [],
            reviewers: (pr.requested_reviewers || []).map((r: any) => ({
                id: r.id?.toString() ?? '',
            })),
            sourceRefName: pr.head?.ref ?? '', // TODO: remove, legacy, use head.ref
            head: {
                ref: pr.head?.ref ?? '',
                sha: pr.head?.sha,
                repo: {
                    id: pr.head?.repo?.id?.toString() ?? '',
                    name: pr.head?.repo?.name ?? '',
                    defaultBranch: pr.head?.repo?.default_branch ?? '',
                    fullName:
                        pr.head?.repo?.full_name ?? pr.head?.repo?.name ?? '',
                },
            },
            targetRefName: pr.base?.ref ?? '', // TODO: remove, legacy, use base.ref
            base: {
                ref: pr.base?.ref ?? '',
                sha: pr.base?.sha,
                repo: {
                    id: repo.id ?? '',
                    name: repo.name ?? '',
                    defaultBranch: repo.default_branch ?? '',
                    fullName: repo.name ?? '',
                },
            },
            user: {
                login: pr.user?.login || pr.user?.username || '',
                name:
                    pr.user?.full_name ||
                    pr.user?.login ||
                    pr.user?.username ||
                    '',
                id: pr.user?.id?.toString() ?? '',
            },
            isDraft:
                pr.title?.toLowerCase().startsWith('wip:') ||
                pr.title?.toLowerCase().startsWith('[wip]') ||
                pr.title?.toLowerCase().startsWith('draft:') ||
                pr.title?.toLowerCase().startsWith('[draft]'),
        };
    }

    async getCommits(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: Partial<Repository>;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<Commit[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        try {
            const authDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const configuredRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !authDetail ||
                !configuredRepositories ||
                configuredRepositories.length === 0
            ) {
                return [];
            }

            let reposToProcess = configuredRepositories;
            if (repository && repository.name) {
                const foundRepo = configuredRepositories.find(
                    (r) => r.name === repository.name,
                );
                if (!foundRepo) {
                    return [];
                }
                reposToProcess = [foundRepo];
            }

            const api = this.createApiClient(authDetail);
            const commits: Commit[] = [];

            for (const repo of reposToProcess) {
                try {
                    const [owner, repoName] = repo.name.split('/');
                    const response = await api.get(
                        `/repos/${owner}/${repoName}/commits`,
                        {
                            params: {
                                sha: filters.branch,
                            },
                        },
                    );

                    for (const commit of response.data || []) {
                        commits.push({
                            sha: commit.sha,
                            commit: {
                                author: {
                                    name: commit.commit?.author?.name,
                                    email: commit.commit?.author?.email,
                                    date: commit.commit?.author?.date,
                                },
                                message: commit.commit?.message,
                            },
                            parents: commit.parents,
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error fetching commits for repository',
                        context: ForgejoService.name,
                        error,
                        metadata: { repositoryId: repo.id },
                    });
                }
            }

            return commits;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching commits from Forgejo',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number; type?: string }[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return [];
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            const api = this.createApiClient(authDetail);
            const repositories = integrationConfig?.configValue || [];
            const usersMap = new Map();

            for (const repo of repositories) {
                try {
                    const [owner, repoName] = repo.name.split('/');
                    const response = await api.get(
                        `/repos/${owner}/${repoName}/collaborators`,
                    );

                    for (const user of response.data || []) {
                        if (!usersMap.has(user.id)) {
                            usersMap.set(user.id, {
                                name:
                                    user.full_name ||
                                    user.login ||
                                    user.username,
                                id: user.id,
                                type: 'user',
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: 'Error fetching collaborators for repository',
                        context: ForgejoService.name,
                        error,
                        metadata: { repositoryName: repo.name },
                    });
                }
            }

            return Array.from(usersMap.values());
        } catch (error) {
            this.logger.error({
                message: 'Error getting list members from Forgejo',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async verifyConnection(
        params: any,
    ): Promise<CodeManagementConnectionStatus> {
        try {
            if (!params.organizationAndTeamData.organizationId) {
                return {
                    platformName: PlatformType.FORGEJO,
                    isSetupComplete: false,
                    hasConnection: false,
                    config: {},
                };
            }

            const [repositories, integration] = await Promise.all([
                this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                ),
                this.integrationService.findOne({
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    status: true,
                    platform: PlatformType.FORGEJO,
                }),
            ]);

            const hasRepositories = repositories?.length > 0;
            const isSetupComplete =
                hasRepositories &&
                !!integration?.authIntegration?.authDetails?.accessToken;

            return {
                platformName: PlatformType.FORGEJO,
                isSetupComplete,
                hasConnection: !!integration,
                config: {
                    hasRepositories,
                },
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: any,
    ): Promise<IntegrationEntity> {
        const authUuid = uuidv4();

        this.logger.log({
            message: 'Creating Forgejo auth integration',
            context: ForgejoService.name,
            metadata: { authUuid, organizationAndTeamData },
        });

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        // Use the returned uuid if available, otherwise fall back to the generated one
        const authIntegrationId = authIntegration?.uuid || authUuid;

        this.logger.log({
            message:
                'Created Forgejo auth integration, now creating integration record',
            context: ForgejoService.name,
            metadata: { authIntegrationId, organizationAndTeamData },
        });

        try {
            const integration = await this.addIntegration(
                organizationAndTeamData,
                authIntegrationId,
            );

            this.logger.log({
                message: 'Successfully created Forgejo integration',
                context: ForgejoService.name,
                metadata: {
                    integrationId: integration?.uuid,
                    authIntegrationId,
                },
            });

            return integration;
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to create Forgejo integration record, cleaning up auth integration',
                context: ForgejoService.name,
                error,
                metadata: { authIntegrationId, organizationAndTeamData },
            });

            // Try to clean up the orphaned auth integration
            try {
                await this.authIntegrationService.delete(authIntegrationId);
            } catch (cleanupError) {
                this.logger.error({
                    message: 'Failed to cleanup orphaned auth integration',
                    context: ForgejoService.name,
                    error: cleanupError,
                });
            }

            throw error;
        }
    }

    async addIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        authIntegrationId: string,
    ): Promise<IntegrationEntity> {
        const integrationUuid = uuidv4();

        this.logger.log({
            message: 'Creating Forgejo integration record',
            context: ForgejoService.name,
            metadata: {
                integrationUuid,
                authIntegrationId,
                organizationAndTeamData,
            },
        });

        const integration = await this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.FORGEJO,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegrationId },
        });

        if (!integration) {
            throw new Error(
                'Failed to create integration record - integrationService.create returned null',
            );
        }

        this.logger.log({
            message: 'Created Forgejo integration record',
            context: ForgejoService.name,
            metadata: {
                integration: {
                    uuid: integration.uuid,
                    platform: integration.platform,
                },
            },
        });

        return integration;
    }

    async getAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ForgejoAuthDetail> {
        const authDetail =
            await this.integrationService.getPlatformAuthDetails<ForgejoAuthDetail>(
                organizationAndTeamData,
                PlatformType.FORGEJO,
            );

        return {
            ...authDetail,
            authMode: AuthMode.TOKEN,
        };
    }

    async findOneByOrganizationAndTeamDataAndConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        configKey: IntegrationConfigKey,
    ): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            if (!integration) return;

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey,
                });

            return integrationConfig?.configValue || null;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getFilesByPullRequestId(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
    }): Promise<RepositoryFile[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return [];
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for files fetch',
                    context: ForgejoService.name,
                    metadata: {
                        repositoryName: params.repository.name,
                    },
                });
                return [];
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}/files`,
            );

            return (response.data || []).map((file: any) => ({
                sha: file.sha,
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting files by pull request ID',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return [];
        }
    }

    async getFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        path: string;
        ref?: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getFile',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/contents/${params.path}`,
                {
                    params: { ref: params.ref },
                },
            );

            const content = response.data?.content;
            if (content) {
                return Buffer.from(content, 'base64').toString('utf-8');
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting file content',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async createPullRequestComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
        body: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for comment creation',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.post(
                `/repos/${owner}/${repoName}/issues/${params.prNumber}/comments`,
                { body: params.body },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request comment',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async createPullRequestReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
        body: string;
        commitId: string;
        path: string;
        line?: number;
        side?: 'LEFT' | 'RIGHT';
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for review comment',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.post(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}/reviews`,
                {
                    body: params.body,
                    commit_id: params.commitId,
                    event: 'COMMENT',
                    comments: [
                        {
                            path: params.path,
                            body: params.body,
                            new_position: params.line,
                        },
                    ],
                },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request review comment',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async updatePullRequestComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        commentId: number;
        body: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for comment update',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.patch(
                `/repos/${owner}/${repoName}/issues/comments/${params.commentId}`,
                { body: params.body },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error updating pull request comment',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async deletePullRequestComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        commentId: number;
    }): Promise<boolean> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return false;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for deletePullRequestComment',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return false;
            }
            const { owner, repo: repoName } = repoData;

            await api.delete(
                `/repos/${owner}/${repoName}/issues/comments/${params.commentId}`,
            );
            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error deleting pull request comment',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return false;
        }
    }

    async getDefaultBranch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
    }): Promise<string> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return 'main';
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getDefaultBranch',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return 'main';
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(`/repos/${owner}/${repoName}`);
            return response.data?.default_branch || 'main';
        } catch (error) {
            this.logger.error({
                message: 'Error getting default branch',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return 'main';
        }
    }

    async createPullRequestWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return;
            }

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!repositories || repositories.length === 0) {
                return;
            }

            const api = this.createApiClient(authDetail);
            const webhookUrl = this.configService.get(
                'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
            );

            if (!webhookUrl) {
                this.logger.warn({
                    message: 'Forgejo webhook URL not configured',
                    context: ForgejoService.name,
                });
                return;
            }

            for (const repo of repositories) {
                try {
                    const [owner, repoName] = repo.name.split('/');

                    // Check if webhook already exists
                    const existingHooks = await api.get(
                        `/repos/${owner}/${repoName}/hooks`,
                    );
                    const hookExists = existingHooks.data?.some(
                        (hook: any) => hook.config?.url === webhookUrl,
                    );

                    if (!hookExists) {
                        await api.post(`/repos/${owner}/${repoName}/hooks`, {
                            type: 'forgejo',
                            config: {
                                url: webhookUrl,
                                content_type: 'json',
                            },
                            events: [
                                'pull_request',
                                'issue_comment',
                                'pull_request_review',
                                'pull_request_review_comment',
                            ],
                            active: true,
                        });

                        this.logger.log({
                            message: `Webhook created for repository ${repo.name}`,
                            context: ForgejoService.name,
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Error creating webhook for repository ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request webhooks',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async getPullRequestsWithFiles(
        params: any,
    ): Promise<PullRequestWithFiles[] | null> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!authDetail || !repositories) {
                return null;
            }

            const api = this.createApiClient(authDetail);
            const pullRequestsWithFiles: PullRequestWithFiles[] = [];

            for (const repo of repositories) {
                try {
                    const [owner, repoName] = repo.name.split('/');
                    const prsResponse = await api.get(
                        `/repos/${owner}/${repoName}/pulls`,
                        {
                            params: { state: 'all', limit: 10 },
                        },
                    );

                    for (const pr of prsResponse.data || []) {
                        const filesResponse = await api.get(
                            `/repos/${owner}/${repoName}/pulls/${pr.number}/files`,
                        );

                        pullRequestsWithFiles.push({
                            id: pr.id,
                            pull_number: pr.number,
                            title: pr.title,
                            state: pr.state,
                            repository: repo.name,
                            repositoryData: {
                                platform: 'forgejo',
                                id: repo.id,
                                name: repo.name,
                                fullName: repo.name,
                                language: '',
                                defaultBranch: repo.default_branch || 'main',
                            },
                            pullRequestFiles: (filesResponse.data || []).map(
                                (file: any) => ({
                                    additions: file.additions,
                                    deletions: file.deletions,
                                    changes: file.changes,
                                    status: file.status,
                                }),
                            ),
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error fetching PRs with files for repository',
                        context: ForgejoService.name,
                        error,
                        metadata: { repositoryId: repo.id },
                    });
                }
            }

            return pullRequestsWithFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests with files',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getTreeByRef(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        ref: string;
    }): Promise<TreeItem[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return [];
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getTreeByRef',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return [];
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/git/trees/${params.ref}`,
                { params: { recursive: true } },
            );

            return (response.data?.tree || []).map((item: any) => ({
                path: item.path,
                mode: item.mode,
                type: item.type,
                sha: item.sha,
                size: item.size,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting tree by ref',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return [];
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
    }): Promise<boolean> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return false;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for approvePullRequest',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return false;
            }
            const { owner, repo: repoName } = repoData;

            await api.post(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}/reviews`,
                {
                    event: 'APPROVE',
                },
            );

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error approving pull request',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return false;
        }
    }

    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
    }): Promise<PullRequestReviewComment[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return [];
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getPullRequestReviewComments',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return [];
            }
            const { owner, repo: repoName } = repoData;

            // Get both issue comments and review comments
            const [commentsResponse, reviewCommentsResponse] =
                await Promise.all([
                    api.get(
                        `/repos/${owner}/${repoName}/issues/${params.prNumber}/comments`,
                    ),
                    api.get(
                        `/repos/${owner}/${repoName}/pulls/${params.prNumber}/comments`,
                    ),
                ]);

            const comments: PullRequestReviewComment[] = [];

            for (const comment of commentsResponse.data || []) {
                comments.push({
                    id: comment.id,
                    body: comment.body,
                    author: {
                        id: comment.user?.id?.toString(),
                        username: comment.user?.login || comment.user?.username,
                    },
                    createdAt: comment.created_at,
                    updatedAt: comment.updated_at,
                });
            }

            for (const comment of reviewCommentsResponse.data || []) {
                comments.push({
                    id: comment.id,
                    body: comment.body,
                    author: {
                        id: comment.user?.id?.toString(),
                        username: comment.user?.login || comment.user?.username,
                    },
                    createdAt: comment.created_at,
                    updatedAt: comment.updated_at,
                });
            }

            return comments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull request review comments',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return [];
        }
    }

    async getComparison(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        base: string;
        head: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getComparison',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/compare/${params.base}...${params.head}`,
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error getting comparison',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async getCloneParams(params: {
        repository: {
            id: string;
            defaultBranch?: string;
            name: string;
        };
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<GitCloneParams> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                throw new Error('Forgejo authentication details not found');
            }

            const token = decrypt(authDetail.accessToken);

            return {
                organizationId: params.organizationAndTeamData.organizationId,
                repositoryId: params.repository.id,
                repositoryName: params.repository.name,
                url: `${authDetail.host}/${params.repository.name}`,
                provider: PlatformType.FORGEJO,
                branch: params.repository.defaultBranch,
                auth: {
                    type: AuthMode.TOKEN,
                    token: token,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting clone params',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            throw error;
        }
    }

    async getPullRequestCodeReviewTime(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<PullRequestCodeReviewTime | null> {
        try {
            const pr = await this.getPullRequestByNumber({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: {
                    name: params.repository.name,
                    id: params.repository.id,
                },
                prNumber: params.prNumber,
            });
            if (!pr) {
                return null;
            }

            return {
                id: pr.number,
                created_at: pr.created_at,
                closed_at: pr.closed_at || '',
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull request code review time',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getCodeReviewReactions(params: any): Promise<any> {
        // Forgejo has limited reaction support compared to GitHub
        return [];
    }

    async syncCodeReviewReactions(params: any): Promise<void> {
        // Not implemented for Forgejo
    }

    async getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for PR fetch',
                    context: ForgejoService.name,
                    metadata: {
                        repositoryName: params.repository.name,
                    },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}`,
            );
            const pr = response.data;

            if (!pr) {
                return null;
            }

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            const repo = repositories?.find(
                (r) => r.name === `${owner}/${repoName}`,
            ) || {
                id: params.repository.id || '',
                name: `${owner}/${repoName}`,
                default_branch: params.repository.defaultBranch || 'main',
            };

            return this.transformPullRequest(
                pr,
                repo as Repositories,
                params.organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull request',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async getPullRequestsForRTTM(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id: string; name: string };
    }): Promise<PullRequestCodeReviewTime[] | null> {
        try {
            const pullRequests = await this.getPullRequests({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                filters: { state: PullRequestState.ALL },
            });

            return pullRequests.map((pr) => ({
                id: parseInt(pr.id) || pr.number,
                created_at: pr.created_at,
                closed_at: pr.closed_at || '',
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests for RTTM',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getChangedFilesSinceLastCommit(params: any): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getChangedFilesSinceLastCommit',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}/files`,
            );
            return response.data || [];
        } catch (error) {
            this.logger.error({
                message: 'Error getting changed files since last commit',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createReviewComment(params: any): Promise<ReviewComment | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            lineComment,
            commit,
            language,
            suggestionCopyPrompt = true,
        } = params;

        try {
            const authDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetail) {
                this.logger.warn({
                    message: 'No auth details found for createReviewComment',
                    context: ForgejoService.name,
                    metadata: { organizationAndTeamData },
                });
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for createReviewComment',
                    context: ForgejoService.name,
                    metadata: {
                        repositoryName: repository?.name,
                    },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            // Get translations for the review comment
            const translations = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ReviewComment,
            );

            // Format the comment body like GitHub does
            const bodyFormatted = this.formatBodyForForgejo(
                lineComment,
                repository,
                translations,
                suggestionCopyPrompt,
            );

            // Calculate start and end lines
            const startLine = lineComment.start_line || lineComment.line;
            const endLine = lineComment.line;

            this.logger.log({
                message: `Creating review comment for PR#${prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    owner,
                    repoName,
                    prNumber,
                    path: lineComment.path,
                    line: endLine,
                    commitSha: commit?.sha?.substring(0, 7),
                },
            });

            const response = await api.post(
                `/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`,
                {
                    body: '', // Empty body for inline-only review
                    commit_id: commit?.sha,
                    event: 'COMMENT',
                    comments: [
                        {
                            path: lineComment.path,
                            body: bodyFormatted,
                            new_position: endLine,
                        },
                    ],
                },
            );

            this.logger.log({
                message: `Created review comment for PR#${prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    reviewId: response.data?.id,
                    prNumber,
                },
            });

            // Return in the expected format
            return {
                id: response.data?.id,
                pullRequestReviewId: response.data?.id?.toString(),
                body: bodyFormatted,
                createdAt: response.data?.submitted_at,
                updatedAt: response.data?.submitted_at,
            };
        } catch (error) {
            const isLineMismatch =
                error.response?.data?.message?.includes('line') ||
                error.response?.data?.message?.includes('position');

            const errorType = isLineMismatch
                ? 'failed_lines_mismatch'
                : 'failed';

            this.logger.error({
                message: `Error creating review comment for PR#${prNumber}`,
                context: ForgejoService.name,
                error,
                metadata: {
                    prNumber,
                    repository: repository?.name,
                    path: lineComment?.path,
                    line: lineComment?.line,
                    commitSha: commit?.sha?.substring(0, 7),
                    errorType,
                    responseStatus: error.response?.status,
                    responseData: error.response?.data,
                },
            });

            throw {
                ...error,
                errorType,
            };
        }
    }

    /**
     * Format the body for a Forgejo review comment (similar to GitHub/GitLab formatting)
     */
    private formatBodyForForgejo(
        lineComment: any,
        repository: any,
        translations: any,
        suggestionCopyPrompt: boolean,
    ): string {
        const improvedCode = lineComment?.body?.improvedCode;
        const language =
            lineComment?.suggestion?.language?.toLowerCase() ||
            repository?.language?.toLowerCase() ||
            '';

        const severityShield = lineComment?.suggestion
            ? getSeverityLevelShield(lineComment.suggestion.severity)
            : '';

        const codeBlock = improvedCode
            ? this.formatCodeBlock(language, improvedCode)
            : '';

        const suggestionContent = lineComment?.body?.suggestionContent || '';
        const actionStatement = lineComment?.body?.actionStatement
            ? `${lineComment.body.actionStatement}\n\n`
            : '';

        const badges =
            [
                getCodeReviewBadge(),
                lineComment?.suggestion
                    ? getLabelShield(lineComment.suggestion.label)
                    : '',
                severityShield,
            ].join(' ') + '\n\n';

        const copyPrompt = suggestionCopyPrompt
            ? this.formatPromptForLLM(lineComment)
            : '';

        return [
            badges,
            suggestionContent,
            actionStatement,
            codeBlock,
            copyPrompt,
            this.formatSub(translations?.talkToKody || ''),
            this.formatSub(translations?.feedback || '') +
            '<!-- kody-codereview -->&#8203;\n&#8203;',
        ]
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    private formatCodeBlock(language: string, code: string): string {
        if (!code) return '';
        return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    }

    private formatSub(text: string): string {
        if (!text) return '';
        return `<sub>${text}</sub>\n`;
    }

    private formatPromptForLLM(lineComment: any): string {
        const prompt = lineComment?.body?.oneLineSummary;
        if (!prompt) return '';
        return `\n<details>\n<summary>Prompt for AI</summary>\n\n\`${prompt}\`\n</details>\n`;
    }

    async createCommentInPullRequest(params: any): Promise<any[] | null> {
        try {
            const result = await this.createPullRequestComment({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
                body: params.body,
            });
            return result ? [result] : null;
        } catch (error) {
            this.logger.error({
                message: 'Error creating comment in pull request',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getRepositoryContentFile(params: any): Promise<any | null> {
        return this.getFile(params);
    }

    async getCommitsForPullRequestForCodeReview(
        params: any,
    ): Promise<any[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                this.logger.warn({
                    message:
                        'No auth details found for getCommitsForPullRequestForCodeReview',
                    context: ForgejoService.name,
                    metadata: { params },
                });
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for commits fetch',
                    context: ForgejoService.name,
                    metadata: {
                        repositoryName: params.repository.name,
                        repoId: params.repository.id,
                    },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            this.logger.log({
                message: 'Fetching commits for PR',
                context: ForgejoService.name,
                metadata: { owner, repoName, prNumber: params.prNumber },
            });

            const response = await api.get(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}/commits`,
            );

            this.logger.log({
                message: 'Got commits for PR',
                context: ForgejoService.name,
                metadata: {
                    owner,
                    repoName,
                    prNumber: params.prNumber,
                    commitCount: response.data?.length || 0,
                    commits: response.data?.map((c: any) =>
                        c.sha?.substring(0, 7),
                    ),
                },
            });

            return response.data || [];
        } catch (error) {
            this.logger.error({
                message: 'Error getting commits for pull request',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async createIssueComment(params: any): Promise<any | null> {
        return this.createPullRequestComment(params);
    }

    async createSingleIssueComment(params: any): Promise<any | null> {
        return this.createPullRequestComment(params);
    }

    async updateIssueComment(params: any): Promise<any | null> {
        return this.updatePullRequestComment(params);
    }

    async minimizeComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        commentId: string;
        reason?:
        | 'ABUSE'
        | 'OFF_TOPIC'
        | 'OUTDATED'
        | 'RESOLVED'
        | 'DUPLICATE'
        | 'SPAM';
    }): Promise<any | null> {
        // Forgejo doesn't support minimizing comments like GitHub
        // We can delete the comment instead or just return null
        this.logger.warn({
            message: 'minimizeComment not supported on Forgejo, skipping',
            context: ForgejoService.name,
        });
        return null;
    }

    async findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null> {
        try {
            return await this.integrationConfigService.findOne({
                configKey: params.configKey,
                configValue: params.configValue,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error finding team and organization by config key',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestReviewComment(params: any): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getPullRequestReviewComment',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/pulls/comments/${params.commentId}`,
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull request review comment',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createResponseToComment(params: any): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for createResponseToComment',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            // Forgejo uses issue comments for PR discussions
            const response = await api.post(
                `/repos/${owner}/${repoName}/issues/${params.prNumber}/comments`,
                { body: params.body },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error creating response to comment',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async updateDescriptionInPullRequest(params: any): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for updateDescriptionInPullRequest',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.patch(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}`,
                { body: params.body },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error updating pull request description',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async countReactions(params: any): Promise<any[]> {
        // Forgejo has limited reaction support
        return [];
    }

    async getLanguageRepository(params: any): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for getLanguageRepository',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.get(
                `/repos/${owner}/${repoName}/languages`,
            );
            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository languages',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getRepositoryAllFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filters?: {
            branch?: string;
            filePatterns?: string[];
            excludePatterns?: string[];
            maxFiles?: number;
        };
    }): Promise<RepositoryFile[]> {
        try {
            const defaultBranch = await this.getDefaultBranch({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
            });

            const tree = await this.getTreeByRef({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                ref: params.filters?.branch || defaultBranch,
            });

            let files = tree.filter((item: TreeItem) => item.type === 'file');

            if (params.filters?.filePatterns?.length) {
                files = files.filter((file: TreeItem) =>
                    params.filters!.filePatterns!.some((pattern) =>
                        isFileMatchingGlobCaseInsensitive(file.path, [pattern]),
                    ),
                );
            }

            if (params.filters?.excludePatterns?.length) {
                files = files.filter(
                    (file: TreeItem) =>
                        !params.filters!.excludePatterns!.some((pattern) =>
                            isFileMatchingGlob(file.path, [pattern]),
                        ),
                );
            }

            if (params.filters?.maxFiles) {
                files = files.slice(0, params.filters.maxFiles);
            }

            return files.map((file: TreeItem) => ({
                sha: file.sha,
                filename: file.path,
                path: file.path,
                type: file.type,
                size: file.size || 0,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting all repository files',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async mergePullRequest(params: any): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            const repoData = extractOwnerAndRepo(params.repository.name);

            if (!repoData) {
                this.logger.error({
                    message:
                        'Could not determine repository owner/name for mergePullRequest',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.repository.name },
                });
                return null;
            }
            const { owner, repo: repoName } = repoData;

            const response = await api.post(
                `/repos/${owner}/${repoName}/pulls/${params.prNumber}/merge`,
                {
                    do: params.mergeMethod || 'merge',
                    merge_message_field: params.commitMessage,
                },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error merging pull request',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getAllCommentsInPullRequest(params: any): Promise<any[]> {
        try {
            const comments = await this.getPullRequestReviewComments({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });
            return comments || [];
        } catch (error) {
            this.logger.error({
                message: 'Error getting all comments in pull request',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);
            const response = await api.get(`/users/${params.username}`);
            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error getting user by username',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email?: string;
        userName: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);

            // Try to search by username first
            try {
                const response = await api.get(`/users/${params.userName}`);
                if (response.data) {
                    return response.data;
                }
            } catch {
                // User not found by username, continue
            }

            // Search users
            const searchResponse = await api.get('/users/search', {
                params: { q: params.userName },
            });

            if (searchResponse.data?.data?.length > 0) {
                // If email provided, try to match
                if (params.email) {
                    const matched = searchResponse.data.data.find(
                        (u: any) => u.email === params.email,
                    );
                    if (matched) return matched;
                }
                return searchResponse.data.data[0];
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting user by email or name',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getUserById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userId: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);
            // Forgejo doesn't have a direct get-user-by-id endpoint
            // We'd need to search or use admin API
            this.logger.warn({
                message: 'getUserById not directly supported on Forgejo',
                context: ForgejoService.name,
            });
            return null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting user by ID',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);
            const response = await api.get('/user');
            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error getting current user',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async markReviewCommentAsResolved(params: any): Promise<any | null> {
        // Forgejo doesn't have a native resolve comment feature like GitHub
        this.logger.warn({
            message: 'markReviewCommentAsResolved not supported on Forgejo',
            context: ForgejoService.name,
        });
        return null;
    }

    async getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    }): Promise<any[]> {
        try {
            const pullRequests = await this.getPullRequests({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
            });
            return pullRequests;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests by repository',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<any | null> {
        try {
            const comments = await this.getPullRequestReviewComments({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            // Check if there are any unresolved Kody comments
            const hasUnresolvedKodyComments = comments?.some(
                (comment: PullRequestReviewComment) =>
                    hasKodyMarker(comment.body),
            );

            return {
                shouldApprove: !hasUnresolvedKodyComments,
                hasUnresolvedComments: hasUnresolvedKodyComments,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error checking if PR should be approved',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return;
            }

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!repositories || repositories.length === 0) {
                return;
            }

            const api = this.createApiClient(authDetail);
            const webhookUrl = this.configService.get(
                'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
            );

            for (const repo of repositories) {
                try {
                    const [owner, repoName] = repo.name.split('/');
                    const existingHooks = await api.get(
                        `/repos/${owner}/${repoName}/hooks`,
                    );

                    for (const hook of existingHooks.data || []) {
                        if (hook.config?.url === webhookUrl) {
                            await api.delete(
                                `/repos/${owner}/${repoName}/hooks/${hook.id}`,
                            );
                        }
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Error deleting webhook for repository ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error deleting webhooks',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return false;
            }

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            const repo = repositories?.find(
                (r) => r.id === params.repositoryId,
            );
            if (!repo) {
                return false;
            }

            const api = this.createApiClient(authDetail);
            const [owner, repoName] = repo.name.split('/');
            const webhookUrl = this.configService.get(
                'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
            );

            const existingHooks = await api.get(
                `/repos/${owner}/${repoName}/hooks`,
            );
            return existingHooks.data?.some(
                (hook: any) => hook.config?.url === webhookUrl && hook.active,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking if webhook is active',
                context: ForgejoService.name,
                error,
            });
            return false;
        }
    }

    async formatReviewCommentBody(params: {
        suggestion: any;
        repository: { name: string; language: string };
        includeHeader?: boolean;
        includeFooter?: boolean;
        language?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        suggestionCopyPrompt?: boolean;
    }): Promise<string> {
        const {
            suggestion,
            includeHeader = true,
            includeFooter = true,
        } = params;

        let body = '';

        if (includeHeader && suggestion.label) {
            const labelShield = getLabelShield(suggestion.label);
            const severityShield = getSeverityLevelShield(
                suggestion.severityLevel,
            );
            body += `${labelShield} ${severityShield}\n\n`;
        }

        body += suggestion.suggestionContent || '';

        if (suggestion.improvedCode) {
            const lang = params.language || params.repository.language || '';
            body += `\n\n\`\`\`suggestion\n${suggestion.improvedCode}\n\`\`\``;
        }

        if (includeFooter) {
            body += `\n\n${getCodeReviewBadge()}`;
        }

        return body;
    }

    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<any> {
        try {
            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            const repo = repositories?.find(
                (r) => r.id === params.repositoryId,
            );
            if (!repo) {
                return [];
            }

            const defaultBranch = await this.getDefaultBranch({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: { name: repo.name },
            });

            return this.getTreeByRef({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: { name: repo.name },
                ref: defaultBranch,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getRepositoryTreeByDirectory(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        directoryPath?: string;
    }): Promise<TreeItem[]> {
        try {
            const tree = await this.getRepositoryTree({
                organizationAndTeamData: params.organizationAndTeamData,
                repositoryId: params.repositoryId,
            });

            if (!params.directoryPath) {
                return tree;
            }

            return tree.filter((item: TreeItem) =>
                item.path.startsWith(params.directoryPath!),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree by directory',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId: string;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null> {
        return this.updatePullRequestComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: {
                name: params.repository.name || '',
                id: params.repository.id,
            },
            commentId: parseInt(params.commentId),
            body: params.body,
        });
    }

    async isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean> {
        try {
            const pr = await this.getPullRequestByNumber({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: {
                    name: params.repository.name || '',
                    id: params.repository.id || '',
                },
                prNumber: params.prNumber,
            });

            if (!pr) {
                return false;
            }

            // Forgejo doesn't have native draft PR support, check title patterns
            const title = pr.title?.toLowerCase() || '';
            return (
                title.startsWith('wip:') ||
                title.startsWith('[wip]') ||
                title.startsWith('draft:') ||
                title.startsWith('[draft]')
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking if PR is draft',
                context: ForgejoService.name,
                error,
            });
            return false;
        }
    }

    async getReviewStatusByPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewState | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return null;
            }

            const api = this.createApiClient(authDetail);
            const repoName = params.repository.name || '';
            const [owner, repo] = repoName.split('/');

            const response = await api.get(
                `/repos/${owner}/${repo}/pulls/${params.prNumber}/reviews`,
            );
            const reviews = response.data || [];

            // Get the most recent review state
            if (reviews.length === 0) {
                return null;
            }

            const latestReview = reviews[reviews.length - 1];
            switch (latestReview.state?.toUpperCase()) {
                case 'APPROVED':
                    return PullRequestReviewState.APPROVED;
                case 'CHANGES_REQUESTED':
                case 'REQUEST_CHANGES':
                    return PullRequestReviewState.CHANGES_REQUESTED;
                case 'COMMENTED':
                    return PullRequestReviewState.COMMENTED;
                case 'PENDING':
                    return PullRequestReviewState.PENDING;
                default:
                    return null;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error getting review status by pull request',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: any;
    }): Promise<void> {
        // Forgejo has limited reaction support
        this.logger.warn({
            message: 'addReactionToPR has limited support on Forgejo',
            context: ForgejoService.name,
        });
    }

    async addReactionToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: any;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return;
            }

            const api = this.createApiClient(authDetail);
            const [owner, repoName] = (params.repository.name || '').split('/');

            await api.post(
                `/repos/${owner}/${repoName}/issues/comments/${params.commentId}/reactions`,
                { content: params.reaction },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error adding reaction to comment',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async removeReactionsFromPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: any[];
    }): Promise<void> {
        // Forgejo has limited reaction support
        this.logger.warn({
            message: 'removeReactionsFromPR has limited support on Forgejo',
            context: ForgejoService.name,
        });
    }

    async removeReactionsFromComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: any[];
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                return;
            }

            const api = this.createApiClient(authDetail);
            const [owner, repoName] = (params.repository.name || '').split('/');

            for (const reaction of params.reactions) {
                try {
                    await api.delete(
                        `/repos/${owner}/${repoName}/issues/comments/${params.commentId}/reactions`,
                        { data: { content: reaction } },
                    );
                } catch {
                    // Ignore errors for individual reactions
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing reactions from comment',
                context: ForgejoService.name,
                error,
            });
        }
    }
}
