import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@kodus/flow';
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
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { IntegrationServiceDecorator } from '@libs/common/utils/decorators/integration-service.decorator';
import { extractOwnerAndRepo } from '@libs/common/utils/helpers';
import { getCodeReviewBadge } from '@libs/common/utils/codeManagement/codeReviewBadge';
import { getSeverityLevelShield } from '@libs/common/utils/codeManagement/severityLevel';
import { getLabelShield } from '@libs/common/utils/codeManagement/labels';
import { hasKodyMarker } from '@libs/common/utils/codeManagement/codeCommentMarkers';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@libs/common/utils/glob-utils';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@libs/common/utils/translations/translations';

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
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import { ForgejoAuthDetail } from '@libs/integrations/domain/authIntegrations/types/forgejo-auth-detail.type';

import {
    ICodeManagementService,
    CodeManagementConnectionStatus,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GitCloneParams } from '@libs/platform/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import {
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestWithFiles,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';

import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import {
    ForgejoClient,
    createForgejoClient,
    ForgejoApiError,
    ForgejoPullRequest,
    ForgejoRepository,
    ForgejoCommit,
} from './forgejo.sdk';

// ============================================================================
// Service Implementation
// ============================================================================

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

    // ========================================================================
    // Private Helpers - SDK Client Creation
    // ========================================================================

    /**
     * Create a ForgejoClient from auth details
     */
    private createClient(authDetail: ForgejoAuthDetail): ForgejoClient {
        const token = decrypt(authDetail.accessToken);
        return createForgejoClient({
            host: authDetail.host,
            token,
        });
    }

    /**
     * Get auth details for an organization/team
     */
    private async getAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ForgejoAuthDetail | null> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            if (!integration?.authIntegration?.authDetails) {
                return null;
            }

            return integration.authIntegration.authDetails as ForgejoAuthDetail;
        } catch (error) {
            this.logger.error({
                message: 'Error getting auth details',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    /**
     * Extract owner and repo from repository name, with logging
     */
    private extractRepoInfo(
        repositoryName: string,
        methodName: string,
    ): { owner: string; repo: string } | null {
        const repoData = extractOwnerAndRepo(repositoryName);
        if (!repoData) {
            this.logger.error({
                message: `Could not parse repository name in ${methodName}`,
                context: ForgejoService.name,
                metadata: { repositoryName },
            });
            return null;
        }
        return repoData;
    }

    // ========================================================================
    // Private Helpers - Data Transformation
    // ========================================================================

    /**
     * Map Forgejo PR state to Kodus PullRequestState
     */
    private mapPullRequestState(pr: ForgejoPullRequest): PullRequestState {
        if (pr.merged) return PullRequestState.MERGED;
        if (pr.state === 'closed') return PullRequestState.CLOSED;
        return PullRequestState.OPENED;
    }

    /**
     * Transform Forgejo PR to Kodus PullRequest type
     */
    private transformPullRequest(
        pr: ForgejoPullRequest,
        repo:
            | Repositories
            | { id: string; name: string; default_branch?: string },
        organizationAndTeamData?: OrganizationAndTeamData,
    ): PullRequest {
        const state = this.mapPullRequestState(pr);
        const repoWithDefaults = {
            id: repo.id ?? '',
            name: repo.name ?? '',
            default_branch:
                ('default_branch' in repo ? repo.default_branch : undefined) ??
                '',
        };

        return {
            id: pr.id?.toString() ?? '',
            number: pr.number ?? -1,
            pull_number: pr.number ?? -1,
            organizationId: organizationAndTeamData?.organizationId ?? '',
            title: pr.title ?? '',
            body: pr.body ?? '',
            state,
            prURL: pr.html_url ?? '',
            repository: repoWithDefaults.name,
            repositoryId: repoWithDefaults.id,
            repositoryData: {
                id: repoWithDefaults.id,
                name: repoWithDefaults.name,
            },
            message: pr.title ?? '',
            created_at: pr.created_at ?? '',
            closed_at: pr.closed_at ?? '',
            updated_at: pr.updated_at ?? '',
            merged_at: pr.merged_at ?? '',
            participants: pr.user?.id ? [{ id: pr.user.id.toString() }] : [],
            reviewers: [],
            sourceRefName: pr.head?.ref ?? '',
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
            targetRefName: pr.base?.ref ?? '',
            base: {
                ref: pr.base?.ref ?? '',
                sha: pr.base?.sha,
                repo: {
                    id: repoWithDefaults.id,
                    name: repoWithDefaults.name,
                    defaultBranch: repoWithDefaults.default_branch,
                    fullName: repoWithDefaults.name,
                },
            },
            user: {
                login: pr.user?.login || '',
                name: pr.user?.full_name || pr.user?.login || '',
                id: pr.user?.id?.toString() ?? '',
            },
            isDraft:
                pr.draft ||
                pr.title?.toLowerCase().startsWith('wip:') ||
                pr.title?.toLowerCase().startsWith('[wip]') ||
                pr.title?.toLowerCase().startsWith('draft:') ||
                pr.title?.toLowerCase().startsWith('[draft]') ||
                false,
        };
    }

    /**
     * Transform Forgejo commit to Kodus Commit type
     */
    private transformCommit(commit: ForgejoCommit): Commit {
        return {
            sha: commit.sha,
            commit: {
                message: commit.commit?.message || '',
                author: {
                    name: commit.commit?.author?.name || '',
                    email: commit.commit?.author?.email || '',
                    date: commit.commit?.author?.date || '',
                },
            },
            parents: commit.parents?.map((p) => ({ sha: p.sha })),
        };
    }

    // ========================================================================
    // Authentication & Integration Methods
    // ========================================================================

    async createAuthIntegration(params: any): Promise<any> {
        return this.authenticateWithToken(params);
    }

    async authenticateWithToken(params: {
        token: string;
        host: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ success: boolean; status: CreateAuthIntegrationStatus }> {
        try {
            const { token, host, organizationAndTeamData } = params;

            this.logger.log({
                message: 'Starting Forgejo token authentication',
                context: ForgejoService.name,
                metadata: { host, hasToken: !!token },
            });

            if (!host) throw new Error('Forgejo host URL is required');
            if (!token) throw new Error('Forgejo access token is required');

            const normalizedHost = host.replace(/\/+$/, '');

            // Test the token
            const testResponse = await axios.get(
                `${normalizedHost}/api/v1/user`,
                {
                    headers: { Authorization: `token ${token}` },
                    timeout: 30000,
                },
            );

            if (!testResponse?.data) {
                throw new Error('Forgejo failed to validate the token.');
            }

            const authDetails: ForgejoAuthDetail = {
                accessToken: encrypt(token),
                authMode: AuthMode.TOKEN,
                host: normalizedHost,
            };

            // Check repository permissions
            const checkRepos = await this.checkRepositoryPermissions({
                authDetails,
            });
            if (!checkRepos.success) return checkRepos;

            // Handle integration creation/update
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

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

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            const errorMessage =
                err?.response?.data?.message || err?.message || 'Unknown error';
            this.logger.error({
                message: 'Error authenticating with Forgejo token',
                context: ForgejoService.name,
                error: err,
                metadata: { errorMessage },
            });
            throw new BadRequestException(
                `Error authenticating with Forgejo: ${errorMessage}`,
            );
        }
    }

    private async checkRepositoryPermissions(params: {
        authDetails: ForgejoAuthDetail;
    }): Promise<{ success: boolean; status: CreateAuthIntegrationStatus }> {
        try {
            const client = this.createClient(params.authDetails);

            const userRepos = await client.getUserRepositories({ limit: 50 });
            if (userRepos.length > 0) {
                return {
                    success: true,
                    status: CreateAuthIntegrationStatus.SUCCESS,
                };
            }

            const orgs = await client.getUserOrganizations({ limit: 50 });
            for (const org of orgs) {
                const orgRepos = await client.getOrganizationRepositories(
                    org.name,
                    { limit: 10 },
                );
                if (orgRepos.length > 0) {
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
                message: 'Failed to check repository permissions',
                context: ForgejoService.name,
                error,
            });
            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        }
    }

    private async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: ForgejoAuthDetail,
    ): Promise<void> {
        const integrationUuid = uuidv4();
        const authIntegrationUuid = uuidv4();

        const newIntegration = await this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.FORGEJO,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        await this.authIntegrationService.create({
            uuid: authIntegrationUuid,
            status: true,
            authDetails,
            integration: { uuid: newIntegration.uuid },
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });
    }

    async updateAuthIntegration(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        authIntegrationId: string;
        integrationId: string;
        authDetails: ForgejoAuthDetail;
    }): Promise<any> {
        await this.integrationService.update(
            {
                uuid: params.integrationId,
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
                authDetails: params.authDetails,
            },
        );
    }

    async createOrUpdateIntegrationConfig(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configKey: IntegrationConfigKey;
        configValue: any;
        type?: 'replace' | 'append';
    }): Promise<any> {
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

            // Create webhooks for newly configured repositories
            this.createPullRequestWebhook({
                organizationAndTeamData: params.organizationAndTeamData,
            });
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async findTeamAndOrganizationIdByConfigKey(params: {
        configKey: IntegrationConfigKey;
        configValue: any;
    }): Promise<IntegrationConfigEntity | null> {
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

    private async findOneByOrganizationAndTeamDataAndConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        configKey: IntegrationConfigKey,
    ): Promise<any> {
        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            platform: PlatformType.FORGEJO,
        });

        if (!integration) return null;

        const config = await this.integrationConfigService.findOne({
            integration: { uuid: integration.uuid },
            configKey,
            team: { uuid: organizationAndTeamData.teamId },
        });

        return config?.configValue || null;
    }

    async verifyConnection(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<CodeManagementConnectionStatus> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!authDetail) {
                return {
                    hasConnection: false,
                    isSetupComplete: false,
                    platformName: PlatformType.FORGEJO,
                    category: IntegrationCategory.CODE_MANAGEMENT,
                };
            }

            const client = this.createClient(authDetail);
            await client.getCurrentUser();

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            return {
                hasConnection: true,
                isSetupComplete:
                    Array.isArray(repositories) && repositories.length > 0,
                platformName: PlatformType.FORGEJO,
                category: IntegrationCategory.CODE_MANAGEMENT,
                config: { repositories },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error verifying Forgejo connection',
                context: ForgejoService.name,
                error,
            });
            return {
                hasConnection: false,
                isSetupComplete: false,
                platformName: PlatformType.FORGEJO,
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        }
    }

    // ========================================================================
    // Repository Methods
    // ========================================================================

    async getRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            archived?: boolean;
            organizationSelected?: string;
            visibility?: 'all' | 'public' | 'private';
            language?: string;
        };
        options?: {
            includePullRequestMetrics?: { lastNDays?: number };
        };
    }): Promise<Repositories[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createClient(authDetail);

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

            const repositories: Repositories[] = [];
            const seenRepoIds = new Set<string>();

            // Fetch ALL user's repositories (paginated)
            const userRepos = await client.getAllUserRepositories();
            for (const repo of userRepos) {
                const repoId = repo.id.toString();
                if (!seenRepoIds.has(repoId)) {
                    seenRepoIds.add(repoId);
                    repositories.push(
                        this.transformRepository(repo, integrationConfig),
                    );
                }
            }

            // Fetch ALL organization repositories (paginated)
            try {
                const orgs = await client.getAllUserOrganizations();
                for (const org of orgs) {
                    const orgRepos = await client.getAllOrganizationRepositories(
                        org.name,
                    );
                    for (const repo of orgRepos) {
                        const repoId = repo.id.toString();
                        if (!seenRepoIds.has(repoId)) {
                            seenRepoIds.add(repoId);
                            repositories.push(
                                this.transformRepository(
                                    repo,
                                    integrationConfig,
                                ),
                            );
                        }
                    }
                }
            } catch (error) {
                this.logger.warn({
                    message: 'Error fetching organization repositories',
                    context: ForgejoService.name,
                    error,
                });
            }

            return repositories;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repositories',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    private transformRepository(
        repo: ForgejoRepository,
        integrationConfig?: IntegrationConfigEntity | null,
    ): Repositories {
        return {
            id: repo.id.toString(),
            name: repo.full_name,
            http_url: repo.clone_url,
            avatar_url: repo.avatar_url || repo.owner?.avatar_url,
            organizationName: repo.owner?.login,
            visibility: repo.private ? 'private' : 'public',
            selected: integrationConfig?.configValue?.some(
                (r: { name: string }) => r?.name === repo.full_name,
            ),
            default_branch: repo.default_branch,
            lastActivityAt: repo.updated_at,
        };
    }

    async getDefaultBranch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
    }): Promise<string> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return 'main';

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getDefaultBranch',
            );
            if (!repoInfo) return 'main';

            const client = this.createClient(authDetail);
            const repo = await client.getRepository(
                repoInfo.owner,
                repoInfo.repo,
            );
            return repo.default_branch || 'main';
        } catch (error) {
            this.logger.error({
                message: 'Error getting default branch',
                context: ForgejoService.name,
                error,
            });
            return 'main';
        }
    }

    async getLanguageRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
    }): Promise<string | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getLanguageRepository',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const languages = await client.getRepositoryLanguages(
                repoInfo.owner,
                repoInfo.repo,
            );

            // Return the language with the most bytes
            const sorted = Object.entries(languages).sort(
                ([, a], [, b]) => b - a,
            );
            return sorted[0]?.[0] || null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository language',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getListMembers(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ name: string; id: string | number }[]> {
        // Forgejo doesn't have a direct team members API like GitHub
        // Return empty array for now
        return [];
    }

    async getCloneParams(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name: string; defaultBranch?: string };
    }): Promise<GitCloneParams> {
        const authDetail = await this.getAuthDetails(
            params.organizationAndTeamData,
        );
        if (!authDetail) {
            throw new Error('No auth details found');
        }

        const repoInfo = this.extractRepoInfo(
            params.repository.name,
            'getCloneParams',
        );
        if (!repoInfo) {
            throw new Error('Invalid repository name');
        }

        const token = decrypt(authDetail.accessToken);
        const cloneUrl = `${authDetail.host}/${params.repository.name}.git`;

        return {
            url: cloneUrl,
            provider: PlatformType.FORGEJO,
            organizationId: params.organizationAndTeamData.organizationId,
            repositoryId: params.repository.id || repoInfo.repo,
            repositoryName: repoInfo.repo,
            branch: params.repository.defaultBranch,
            auth: {
                type: authDetail.authMode,
                username: 'oauth2',
                token,
            },
        };
    }

    // ========================================================================
    // Pull Request Methods
    // ========================================================================

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
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createClient(authDetail);
            const pullRequests: PullRequest[] = [];

            // Get configured repositories
            let repositories = params.repository
                ? [params.repository]
                : await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories || !Array.isArray(repositories)) {
                repositories = [];
            }

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequests',
                );
                if (!repoInfo) continue;

                try {
                    const state = this.mapStateToForgejoState(
                        params.filters?.state,
                    );
                    const prs = await client.listAllPullRequests(
                        repoInfo.owner,
                        repoInfo.repo,
                        { state },
                    );

                    for (const pr of prs) {
                        const transformed = this.transformPullRequest(pr, repo);

                        // Apply filters
                        if (
                            params.filters?.startDate &&
                            new Date(pr.created_at) < params.filters.startDate
                        )
                            continue;
                        if (
                            params.filters?.endDate &&
                            new Date(pr.created_at) > params.filters.endDate
                        )
                            continue;
                        if (
                            params.filters?.author &&
                            pr.user?.login !== params.filters.author
                        )
                            continue;
                        if (
                            params.filters?.branch &&
                            pr.head?.ref !== params.filters.branch
                        )
                            continue;

                        pullRequests.push(transformed);
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PRs for repository ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return pullRequests;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    private mapStateToForgejoState(
        state?: PullRequestState,
    ): 'open' | 'closed' | 'all' {
        if (!state) return 'all';
        if (state === PullRequestState.OPENED) return 'open';
        return 'closed';
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
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequest',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const pr = await client.getPullRequest(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            return this.transformPullRequest(pr, {
                id: params.repository.id || '',
                name: params.repository.name!,
            });
        } catch (error) {
            if (error instanceof ForgejoApiError && error.status === 404) {
                return null;
            }
            this.logger.error({
                message: 'Error getting pull request',
                context: ForgejoService.name,
                error,
                metadata: { prNumber: params.prNumber },
            });
            return null;
        }
    }

    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
    }): Promise<PullRequest | null> {
        return this.getPullRequest(params);
    }

    async getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    }): Promise<PullRequest[]> {
        return this.getPullRequests({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
        });
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id: string; name: string };
        filters?: { state?: PullRequestState };
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createClient(authDetail);
            const result: PullRequestWithFiles[] = [];

            const repositories = params.repository
                ? [params.repository]
                : await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) return null;

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequestsWithFiles',
                );
                if (!repoInfo) continue;

                try {
                    const prs = await client.listAllPullRequests(
                        repoInfo.owner,
                        repoInfo.repo,
                        {
                            state: this.mapStateToForgejoState(
                                params.filters?.state,
                            ),
                        },
                    );

                    for (const pr of prs) {
                        const files = await client.getAllPullRequestFiles(
                            repoInfo.owner,
                            repoInfo.repo,
                            pr.number,
                        );
                        result.push({
                            id: pr.id,
                            pull_number: pr.number,
                            state: pr.state || 'open',
                            title: pr.title || '',
                            repository: repo.name,
                            repositoryData: {
                                platform: 'forgejo',
                                id: repo.id || '',
                                name: repoInfo.repo,
                                fullName: repo.name,
                                language: repo.language || '',
                                defaultBranch: repo.default_branch || 'main',
                            },
                            pullRequestFiles: files.map((f) => ({
                                additions: f.additions,
                                deletions: f.deletions,
                                changes: f.changes,
                                status: f.status,
                            })),
                        });
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PRs with files for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests with files',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestsForRTTM(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<PullRequestCodeReviewTime[] | null> {
        // Not implemented for Forgejo - return null
        return null;
    }

    async getFilesByPullRequestId(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getFilesByPullRequestId',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const files = await client.getPullRequestFiles(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            return files.map((f) => ({
                sha: '',
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: '',
                previous_filename: f.previous_filename,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting files by PR ID',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getChangedFilesSinceLastCommit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        lastCommitSha: string;
    }): Promise<any | null> {
        // For simplicity, return all files - Forgejo doesn't have easy diff between commits
        return this.getFilesByPullRequestId(params);
    }

    async isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean> {
        try {
            const pr = await this.getPullRequest(params);
            return pr?.isDraft || false;
        } catch {
            return false;
        }
    }

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        determineBots?: boolean;
    }): Promise<PullRequestAuthor[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createClient(authDetail);
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) return [];

            const authorsMap = new Map<string, PullRequestAuthor>();

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequestAuthors',
                );
                if (!repoInfo) continue;

                try {
                    const prs = await client.listAllPullRequests(
                        repoInfo.owner,
                        repoInfo.repo,
                        { state: 'all' },
                    );

                    for (const pr of prs) {
                        if (
                            pr.user?.id &&
                            !authorsMap.has(pr.user.id.toString())
                        ) {
                            authorsMap.set(pr.user.id.toString(), {
                                id: pr.user.id.toString(),
                                name: pr.user.full_name || pr.user.login || '',
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PR authors for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return Array.from(authorsMap.values());
        } catch (error) {
            this.logger.error({
                message: 'Error getting PR authors',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    // ========================================================================
    // Commit Methods
    // ========================================================================

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
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createClient(authDetail);
            const commits: Commit[] = [];

            const repositories = params.repository
                ? [params.repository]
                : await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) return [];

            for (const repo of repositories) {
                if (!repo.name) continue;
                const repoInfo = this.extractRepoInfo(repo.name, 'getCommits');
                if (!repoInfo) continue;

                try {
                    const repoCommits = await client.listAllCommits(
                        repoInfo.owner,
                        repoInfo.repo,
                        { sha: params.filters?.branch },
                    );

                    for (const commit of repoCommits) {
                        const transformed = this.transformCommit(commit);

                        // Apply date filters
                        const commitDate = new Date(
                            commit.commit?.author?.date || '',
                        );
                        if (
                            params.filters?.startDate &&
                            commitDate < params.filters.startDate
                        )
                            continue;
                        if (
                            params.filters?.endDate &&
                            commitDate > params.filters.endDate
                        )
                            continue;
                        if (
                            params.filters?.author &&
                            commit.commit?.author?.name !==
                            params.filters.author
                        )
                            continue;

                        commits.push(transformed);
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching commits for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return commits;
        } catch (error) {
            this.logger.error({
                message: 'Error getting commits',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getCommitsForPullRequestForCodeReview(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<Commit[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getCommitsForPullRequestForCodeReview',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const commits = await client.getAllPullRequestCommits(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            return commits.map((c) => this.transformCommit(c));
        } catch (error) {
            this.logger.error({
                message: 'Error getting commits for PR',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    // ========================================================================
    // PR Actions (Merge, Approve, etc.)
    // ========================================================================

    async mergePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        mergeMethod?: 'merge' | 'squash' | 'rebase';
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) throw new Error('No auth details');

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'mergePullRequest',
            );
            if (!repoInfo) throw new Error('Invalid repository name');

            const client = this.createClient(authDetail);

            const mergeMethodMap: Record<
                string,
                'merge' | 'squash' | 'rebase'
            > = {
                merge: 'merge',
                squash: 'squash',
                rebase: 'rebase',
            };

            await client.mergePullRequest(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
                {
                    Do:
                        mergeMethodMap[params.mergeMethod || 'merge'] ||
                        'merge',
                },
            );

            return { success: true };
        } catch (error) {
            this.logger.error({
                message: 'Error merging pull request',
                context: ForgejoService.name,
                error,
            });
            throw error;
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body?: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) throw new Error('No auth details');

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'approvePullRequest',
            );
            if (!repoInfo) throw new Error('Invalid repository name');

            const client = this.createClient(authDetail);

            const review = await client.createPullRequestReview(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
                {
                    event: 'APPROVED',
                    body: params.body || '',
                },
            );

            return review;
        } catch (error) {
            this.logger.error({
                message: 'Error approving pull request',
                context: ForgejoService.name,
                error,
            });
            throw error;
        }
    }

    async updateDescriptionInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'updateDescriptionInPullRequest',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);

            const pr = await client.updatePullRequest(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
                {
                    body: params.body,
                },
            );

            return pr;
        } catch (error) {
            this.logger.error({
                message: 'Error updating PR description',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<{ shouldApprove: boolean; reason?: string } | null> {
        // Simple implementation - check if PR is open and not draft
        try {
            const pr = await this.getPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            if (!pr) return null;

            return {
                shouldApprove:
                    pr.state === PullRequestState.OPENED && !pr.isDraft,
                reason: pr.isDraft ? 'PR is a draft' : undefined,
            };
        } catch (error) {
            return null;
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
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getReviewStatusByPullRequest',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const reviews = await client.listPullRequestReviews(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            // Get the latest review status
            if (reviews.length === 0) return null;

            const latestReview = reviews[reviews.length - 1];

            switch (latestReview.state) {
                case 'APPROVED':
                    return PullRequestReviewState.APPROVED;
                case 'REQUEST_CHANGES':
                    return PullRequestReviewState.CHANGES_REQUESTED;
                case 'COMMENT':
                    return PullRequestReviewState.COMMENTED;
                default:
                    return PullRequestReviewState.PENDING;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error getting review status',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    // ========================================================================
    // Comment Methods
    // ========================================================================

    async createReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; language?: string };
        prNumber: number;
        lineComment: any; // Contains path, line, body, start_line, suggestion etc.
        commit?: { sha: string };
        language?: LanguageValue;
        suggestionCopyPrompt?: boolean;
    }): Promise<ReviewComment | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'createReviewComment',
            );
            if (!repoInfo) return null;

            const { lineComment, commit, language, suggestionCopyPrompt } =
                params;

            // Get translations
            const translations = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ReviewComment,
            );

            // Format the comment body
            const bodyFormatted = this.formatBodyForForgejo(
                lineComment,
                params.repository,
                translations,
                suggestionCopyPrompt || false,
            );

            const endLine = lineComment.line;

            this.logger.log({
                message: `Creating review comment for PR#${params.prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    prNumber: params.prNumber,
                    path: lineComment.path,
                    line: endLine,
                    commitSha: commit?.sha?.substring(0, 7),
                },
            });

            const client = this.createClient(authDetail);
            const review = await client.createPullRequestReview(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
                {
                    body: '',
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
                message: `Created review comment for PR#${params.prNumber}`,
                context: ForgejoService.name,
                metadata: { reviewId: review?.id },
            });

            return {
                id: review?.id,
                pullRequestReviewId: review?.id?.toString(),
                body: bodyFormatted,
                createdAt: review?.submitted_at,
                updatedAt: review?.submitted_at,
            };
        } catch (error: any) {
            const isLineMismatch =
                error.responseData?.message?.includes('line') ||
                error.responseData?.message?.includes('position');

            const errorType = isLineMismatch
                ? 'failed_lines_mismatch'
                : 'failed';

            this.logger.error({
                message: `Error creating review comment for PR#${params.prNumber}`,
                context: ForgejoService.name,
                error,
                metadata: { errorType },
            });

            throw { ...error, errorType };
        }
    }

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
            ? `\n\`\`\`${language}\n${improvedCode}\n\`\`\`\n`
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

        const formatSub = (text: string) =>
            text ? `<sub>${text}</sub>\n` : '';

        return [
            badges,
            suggestionContent,
            actionStatement,
            codeBlock,
            copyPrompt,
            formatSub(translations?.talkToKody || ''),
            formatSub(translations?.feedback || '') +
            '<!-- kody-codereview -->&#8203;\n&#8203;',
        ]
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    private formatPromptForLLM(lineComment: any): string {
        const prompt = lineComment?.body?.oneLineSummary;
        if (!prompt) return '';
        return `\n<details>\n<summary>Prompt for AI</summary>\n\n\`${prompt}\`\n</details>\n`;
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
        const translations = getTranslationsForLanguageByCategory(
            (params.language || 'en') as LanguageValue,
            TranslationsCategory.ReviewComment,
        );

        return this.formatBodyForForgejo(
            { suggestion: params.suggestion, body: params.suggestion },
            params.repository,
            translations,
            params.suggestionCopyPrompt || false,
        );
    }

    async createCommentInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any[] | null> {
        try {
            const result = await this.createIssueComment(params);
            return result ? [result] : null;
        } catch (error) {
            this.logger.error({
                message: 'Error creating comment in PR',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'createIssueComment',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const comment = await client.createIssueComment(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
                params.body,
            );

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error creating issue comment',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createSingleIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        return this.createIssueComment(params);
    }

    async updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        commentId: number;
        body: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'updateIssueComment',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const comment = await client.updateIssueComment(
                repoInfo.owner,
                repoInfo.repo,
                params.commentId,
                params.body,
            );

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error updating issue comment',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getAllCommentsInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<any[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getAllCommentsInPullRequest',
            );
            if (!repoInfo) return [];

            const client = this.createClient(authDetail);
            const comments = await client.listIssueComments(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            return comments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting all comments in PR',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getPullRequestReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        commentId: number;
    }): Promise<any | null> {
        try {
            const comments = await this.getPullRequestReviewComments({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            return comments?.find((c) => c.id === params.commentId) || null;
        } catch (error) {
            return null;
        }
    }

    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequestReviewComments',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const comments = await client.getPullRequestReviewComments(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            return comments.map((c) => ({
                id: c.id,
                body: c.body,
                path: c.path,
                line: c.line,
                commit_id: c.commit_id,
                user: {
                    id: c.user?.id?.toString() || '',
                    login: c.user?.login || '',
                },
                created_at: c.created_at,
                updated_at: c.updated_at,
                html_url: c.html_url,
                isFromKody: hasKodyMarker(c.body),
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting PR review comments',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        commentId: string;
        body: string;
    }): Promise<any | null> {
        // Forgejo doesn't support threaded replies to review comments
        // Create a regular issue comment instead
        return this.createIssueComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: { name: params.repository.name! },
            prNumber: params.prNumber,
            body: params.body,
        });
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId: string;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null> {
        return this.updateIssueComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: { name: params.repository.name! },
            commentId: parseInt(params.commentId, 10),
            body: params.body,
        });
    }

    // TODO: yes it does?
    async markReviewCommentAsResolved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        commentId: string;
    }): Promise<any | null> {
        // Forgejo doesn't have a built-in "resolve" feature for comments
        // Return null to indicate not supported
        return null;
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
        // Forgejo doesn't support minimizing comments
        return null;
    }

    // ========================================================================
    // File Content & Tree Methods
    // ========================================================================

    async getRepositoryContentFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        path: string;
        ref?: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getRepositoryContentFile',
            );
            if (!repoInfo) return null;

            const client = this.createClient(authDetail);
            const content = await client.getContents(
                repoInfo.owner,
                repoInfo.repo,
                params.path,
                params.ref,
            );

            // If it's an array (directory listing), return null
            if (Array.isArray(content)) return null;

            // Decode base64 content
            const decodedContent =
                content.encoding === 'base64'
                    ? Buffer.from(content.content, 'base64').toString('utf-8')
                    : content.content;

            return {
                name: content.name,
                path: content.path,
                sha: content.sha,
                size: content.size,
                type: content.type,
                content: decodedContent,
                encoding: 'utf-8',
                html_url: content.html_url,
                download_url: content.download_url,
            };
        } catch (error) {
            if (error instanceof ForgejoApiError && error.status === 404) {
                return null;
            }
            this.logger.error({
                message: 'Error getting file content',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<TreeItem[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            // Get repository name from config
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const repo = repositories?.find(
                (r: any) => r.id === params.repositoryId,
            );
            if (!repo) return [];

            const repoInfo = this.extractRepoInfo(
                repo.name,
                'getRepositoryTree',
            );
            if (!repoInfo) return [];

            const client = this.createClient(authDetail);

            // Get default branch
            const repoData = await client.getRepository(
                repoInfo.owner,
                repoInfo.repo,
            );
            const defaultBranch = repoData.default_branch || 'main';

            // Get tree recursively
            const tree = await client.getTree(
                repoInfo.owner,
                repoInfo.repo,
                defaultBranch,
                {
                    recursive: true,
                },
            );

            return tree.tree.map((item) => ({
                path: item.path,
                type:
                    item.type === 'blob'
                        ? ('file' as const)
                        : ('directory' as const),
                sha: item.sha,
                size: item.size,
                url: item.url || '',
                hasChildren: item.type !== 'blob',
            }));
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
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const repo = repositories?.find(
                (r: any) => r.id === params.repositoryId,
            );
            if (!repo) return [];

            const repoInfo = this.extractRepoInfo(
                repo.name,
                'getRepositoryTreeByDirectory',
            );
            if (!repoInfo) return [];

            const client = this.createClient(authDetail);

            // Get contents of the directory
            const path = params.directoryPath || '';
            const contents = await client.getContents(
                repoInfo.owner,
                repoInfo.repo,
                path,
            );

            if (!Array.isArray(contents)) {
                return [];
            }

            return contents.map((item) => ({
                path: item.path,
                type:
                    item.type === 'file'
                        ? ('file' as const)
                        : ('directory' as const),
                sha: item.sha,
                size: item.size,
                url: item.html_url || item.download_url || '',
                hasChildren: item.type !== 'file',
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree by directory',
                context: ForgejoService.name,
                error,
            });
            return [];
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
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getRepositoryAllFiles',
            );
            if (!repoInfo) return [];

            const client = this.createClient(authDetail);

            const branch = params.filters?.branch || 'main';
            const tree = await client.getTree(
                repoInfo.owner,
                repoInfo.repo,
                branch,
                {
                    recursive: true,
                },
            );

            let files = tree.tree
                .filter((item) => item.type === 'blob')
                .map((item) => ({
                    path: item.path,
                    type: 'file',
                    filename: item.path.split('/').pop() || item.path,
                    sha: item.sha,
                    size: item.size || 0,
                }));

            // Apply file pattern filters
            if (params.filters?.filePatterns?.length) {
                files = files.filter((f) =>
                    isFileMatchingGlobCaseInsensitive(
                        f.path,
                        params.filters!.filePatterns!,
                    ),
                );
            }

            // Apply exclude patterns
            if (params.filters?.excludePatterns?.length) {
                files = files.filter(
                    (f) =>
                        !isFileMatchingGlob(
                            f.path,
                            params.filters!.excludePatterns!,
                        ),
                );
            }

            // Apply max files limit
            if (params.filters?.maxFiles) {
                files = files.slice(0, params.filters.maxFiles);
            }

            return files;
        } catch (error) {
            this.logger.error({
                message: 'Error getting all repository files',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    // ========================================================================
    // User Methods
    // ========================================================================

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createClient(authDetail);
            const user = await client.getUser(params.username);

            return {
                id: user.id.toString(),
                login: user.login,
                name: user.full_name || user.login,
                email: user.email,
                avatar_url: user.avatar_url,
            };
        } catch (error) {
            if (error instanceof ForgejoApiError && error.status === 404) {
                return null;
            }
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
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createClient(authDetail);

            // Try by username first
            try {
                const user = await client.getUser(params.userName);
                return {
                    id: user.id.toString(),
                    login: user.login,
                    name: user.full_name || user.login,
                    email: user.email,
                    avatar_url: user.avatar_url,
                };
            } catch {
                // Not found by username, try search
            }

            // Search by query
            const searchResult = await client.searchUsers({
                q: params.userName,
                limit: 10,
            });
            if (searchResult.data?.length > 0) {
                const user = searchResult.data[0];
                return {
                    id: user.id.toString(),
                    login: user.login,
                    name: user.full_name || user.login,
                    email: user.email,
                    avatar_url: user.avatar_url,
                };
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
        // Forgejo doesn't have a direct get-user-by-ID endpoint
        // Would need to search or use a cached mapping
        return null;
    }

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createClient(authDetail);
            const user = await client.getCurrentUser();

            return {
                id: user.id.toString(),
                login: user.login,
                name: user.full_name || user.login,
                email: user.email,
                avatar_url: user.avatar_url,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting current user',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    // ========================================================================
    // Webhook Methods
    // ========================================================================

    async deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) return;

            const client = this.createClient(authDetail);
            const webhookUrl = this.configService.get<string>(
                'FORGEJO_WEBHOOK_URL',
            );

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'deleteWebhook',
                );
                if (!repoInfo) continue;

                try {
                    const hooks = await client.listWebhooks(
                        repoInfo.owner,
                        repoInfo.repo,
                    );
                    for (const hook of hooks) {
                        if (hook.config?.url === webhookUrl) {
                            await client.deleteWebhook(
                                repoInfo.owner,
                                repoInfo.repo,
                                hook.id,
                            );
                            this.logger.log({
                                message: `Deleted webhook for ${repo.name}`,
                                context: ForgejoService.name,
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error deleting webhook for ${repo.name}`,
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

    async createPullRequestWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories || repositories.length === 0) return;

            const client = this.createClient(authDetail);
            const webhookUrl = this.configService.get<string>(
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
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'createPullRequestWebhook',
                );
                if (!repoInfo) continue;

                try {
                    // Check if webhook already exists
                    const existingHooks = await client.listWebhooks(
                        repoInfo.owner,
                        repoInfo.repo,
                    );
                    const hookExists = existingHooks.some(
                        (hook) => hook.config?.url === webhookUrl,
                    );

                    if (!hookExists) {
                        await client.createWebhook(
                            repoInfo.owner,
                            repoInfo.repo,
                            {
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
                            },
                        );

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

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return false;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const repo = repositories?.find(
                (r: any) => r.id === params.repositoryId,
            );
            if (!repo) return false;

            const repoInfo = this.extractRepoInfo(repo.name, 'isWebhookActive');
            if (!repoInfo) return false;

            const client = this.createClient(authDetail);
            const webhookUrl = this.configService.get<string>(
                'FORGEJO_WEBHOOK_URL',
            );

            const hooks = await client.listWebhooks(
                repoInfo.owner,
                repoInfo.repo,
            );
            return hooks.some(
                (hook) => hook.config?.url === webhookUrl && hook.active,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking webhook status',
                context: ForgejoService.name,
                error,
            });
            return false;
        }
    }

    // ========================================================================
    // Reaction Methods (Optional)
    // ========================================================================

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: string;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'addReactionToPR',
            );
            if (!repoInfo) return;

            const client = this.createClient(authDetail);
            await client.addIssueReaction(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
                params.reaction,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error adding reaction to PR',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async addReactionToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: string;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'addReactionToComment',
            );
            if (!repoInfo) return;

            const client = this.createClient(authDetail);
            await client.addCommentReaction(
                repoInfo.owner,
                repoInfo.repo,
                params.commentId,
                params.reaction,
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
        reactions: string[];
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'removeReactionsFromPR',
            );
            if (!repoInfo) return;

            const client = this.createClient(authDetail);
            for (const reaction of params.reactions) {
                await client.removeIssueReaction(
                    repoInfo.owner,
                    repoInfo.repo,
                    params.prNumber,
                    reaction,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing reactions from PR',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async removeReactionsFromComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: string[];
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'removeReactionsFromComment',
            );
            if (!repoInfo) return;

            const client = this.createClient(authDetail);
            for (const reaction of params.reactions) {
                await client.removeCommentReaction(
                    repoInfo.owner,
                    repoInfo.repo,
                    params.commentId,
                    reaction,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing reactions from comment',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async countReactions(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<any[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'countReactions',
            );
            if (!repoInfo) return [];

            const client = this.createClient(authDetail);
            const reactions = await client.getIssueReactions(
                repoInfo.owner,
                repoInfo.repo,
                params.prNumber,
            );

            // Group by reaction type
            const counts: Record<string, number> = {};
            for (const r of reactions) {
                counts[r.content] = (counts[r.content] || 0) + 1;
            }

            return Object.entries(counts).map(([reaction, count]) => ({
                content: reaction,
                count,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error counting reactions',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }
}
