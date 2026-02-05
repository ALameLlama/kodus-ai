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
    CommentResult,
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
    PullRequestsWithChangesRequested,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { Organization } from '@libs/platform/domain/platformIntegrations/types/codeManagement/organization.type';

import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import {
    OpenAPI,
    ApiError,
    UserService,
    RepositoryService,
    OrganizationService,
    IssueService,
    type PullRequest as ForgejoPullRequest,
    type Repository as ForgejoRepository,
    type Commit as ForgejoCommit,
    type PullReview as ForgejoPullReview,
    type Organization as ForgejoOrganization,
    type ChangedFile as ForgejoChangedFile,
    type User as ForgejoUser,
} from '@llamaduck/forgejo-ts';
import { Reaction } from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';

// ============================================================================
// Service Implementation
// ============================================================================

@Injectable()
@IntegrationServiceDecorator(PlatformType.FORGEJO, 'codeManagement')
export class ForgejoService implements Omit<
    ICodeManagementService,
    'getAuthenticationOAuthToken'
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
    // Private Helpers - SDK Configuration
    // ========================================================================

    private configureSDK(authDetail: ForgejoAuthDetail): void {
        const token = decrypt(authDetail.accessToken);
        OpenAPI.BASE = `${authDetail.host}/api/v1`;
        OpenAPI.TOKEN = token;
    }

    /**
     * Helper to paginate through all results of an API endpoint.
     * Forgejo uses page-based pagination with a default limit of 50.
     */
    private async paginate<T>(
        fetchPage: (page: number, limit: number) => Promise<T[]>,
        options: { limit?: number; maxPages?: number } = {},
    ): Promise<T[]> {
        const limit = options.limit ?? 50;
        const maxPages = options.maxPages ?? 100;
        const allItems: T[] = [];
        let page = 1;

        while (page <= maxPages) {
            const items = await fetchPage(page, limit);
            allItems.push(...items);

            if (items.length < limit) {
                break;
            }
            page++;
        }

        return allItems;
    }

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

    private mapPullRequestState(pr: ForgejoPullRequest): PullRequestState {
        if (pr.merged) return PullRequestState.MERGED;
        if (pr.state === 'closed') return PullRequestState.CLOSED;
        return PullRequestState.OPENED;
    }

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
     * Parses a unified diff string and extracts per-file patches.
     * Returns a map of filename -> patch content.
     */
    private parseUnifiedDiff(diffContent: string): Map<string, string> {
        const patchMap = new Map<string, string>();

        if (!diffContent) {
            return patchMap;
        }

        // Split by file diff headers (diff --git a/... b/...)
        const fileDiffs = diffContent.split(/(?=^diff --git )/m);

        for (const fileDiff of fileDiffs) {
            if (!fileDiff.trim()) continue;

            // Extract filename from the diff header
            // Format: diff --git a/path/to/file b/path/to/file
            const headerMatch = fileDiff.match(
                /^diff --git a\/(.+?) b\/(.+?)$/m,
            );
            if (!headerMatch) continue;

            // Use the 'b' path (new filename, handles renames)
            const filename = headerMatch[2];

            // Find where the actual patch starts (after the header lines)
            // The patch starts at the first @@ line
            const patchStartIndex = fileDiff.indexOf('@@');
            if (patchStartIndex === -1) {
                // No hunks - might be a binary file or mode change only
                patchMap.set(filename, '');
                continue;
            }

            // Extract just the patch part (from @@ onwards)
            const patch = fileDiff.substring(patchStartIndex);
            patchMap.set(filename, patch.trim());
        }

        return patchMap;
    }

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

            const checkRepos = await this.checkRepositoryPermissions({
                authDetails,
            });
            if (!checkRepos.success) return checkRepos;

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
            this.configureSDK(params.authDetails);

            const userRepos = await UserService.userCurrentListRepos({
                limit: 50,
            });
            if (userRepos.length > 0) {
                return {
                    success: true,
                    status: CreateAuthIntegrationStatus.SUCCESS,
                };
            }

            const orgs = await OrganizationService.orgListCurrentUserOrgs({
                limit: 50,
            });
            for (const org of orgs) {
                const orgRepos = await OrganizationService.orgListRepos({
                    org: org.name!,
                    limit: 10,
                });
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

            this.configureSDK(authDetail);
            await UserService.userGetCurrent();

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

            this.configureSDK(authDetail);

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

            // Fetch all user repositories with pagination
            const userRepos = await this.paginate<ForgejoRepository>(
                (page, limit) =>
                    UserService.userCurrentListRepos({ page, limit }),
            );
            for (const repo of userRepos) {
                const repoId = repo.id!.toString();
                if (!seenRepoIds.has(repoId)) {
                    seenRepoIds.add(repoId);
                    repositories.push(
                        this.transformRepository(repo, integrationConfig),
                    );
                }
            }

            try {
                // Fetch all organizations with pagination
                const orgs = await this.paginate<ForgejoOrganization>(
                    (page, limit) =>
                        OrganizationService.orgListCurrentUserOrgs({
                            page,
                            limit,
                        }),
                );
                for (const org of orgs) {
                    // Fetch all repos for each organization with pagination
                    const orgRepos = await this.paginate<ForgejoRepository>(
                        (page, limit) =>
                            OrganizationService.orgListRepos({
                                org: org.name!,
                                page,
                                limit,
                            }),
                    );
                    for (const repo of orgRepos) {
                        const repoId = repo.id!.toString();
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
            id: repo.id!.toString(),
            name: repo.full_name!,
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

            this.configureSDK(authDetail);
            const repo = await RepositoryService.repoGet({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
            });
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

            this.configureSDK(authDetail);
            const languages = await RepositoryService.repoGetLanguages({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
            });

            const sorted = Object.entries(
                languages as Record<string, number>,
            ).sort(([, a], [, b]) => b - a);
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
    }): Promise<{ name: string; id: string | number; type?: string }[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            this.configureSDK(authDetail);

            // Get organizations the user belongs to
            const orgs = await this.paginate<ForgejoOrganization>(
                (page, limit) =>
                    OrganizationService.orgListCurrentUserOrgs({ page, limit }),
            );

            const allMembers: {
                name: string;
                id: string | number;
                type?: string;
            }[] = [];
            const seenIds = new Set<string>();

            // Get members from each organization
            for (const org of orgs) {
                if (!org.name) continue;

                try {
                    const members = await this.paginate<ForgejoUser>(
                        (page, limit) =>
                            OrganizationService.orgListMembers({
                                org: org.name!,
                                page,
                                limit,
                            }),
                    );

                    for (const member of members) {
                        const memberId = member.id?.toString() ?? '';
                        if (!seenIds.has(memberId)) {
                            seenIds.add(memberId);
                            allMembers.push({
                                name: member.login ?? member.full_name ?? '',
                                id: member.id ?? '',
                                type: member.is_admin ? 'admin' : 'user',
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching members for org ${org.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return allMembers;
        } catch (error) {
            this.logger.error({
                message: 'Error getting list members',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
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

            this.configureSDK(authDetail);
            const pullRequests: PullRequest[] = [];

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
                    // Paginate through all PRs
                    const prs = await this.paginate<ForgejoPullRequest>(
                        (page, limit) =>
                            RepositoryService.repoListPullRequests({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                state,
                                page,
                                limit,
                            }),
                    );

                    for (const pr of prs) {
                        const transformed = this.transformPullRequest(pr, repo);

                        if (
                            params.filters?.startDate &&
                            new Date(pr.created_at!) < params.filters.startDate
                        )
                            continue;
                        if (
                            params.filters?.endDate &&
                            new Date(pr.created_at!) > params.filters.endDate
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

            this.configureSDK(authDetail);
            const pr = await RepositoryService.repoGetPullRequest({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
            });

            return this.transformPullRequest(pr, {
                id: params.repository.id || '',
                name: params.repository.name!,
            });
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
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

            this.configureSDK(authDetail);
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
                    const state = this.mapStateToForgejoState(
                        params.filters?.state,
                    );
                    const prs = await this.paginate<ForgejoPullRequest>(
                        (page, limit) =>
                            RepositoryService.repoListPullRequests({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                state,
                                page,
                                limit,
                            }),
                    );

                    for (const pr of prs) {
                        const files = await this.paginate<ForgejoChangedFile>(
                            (page, limit) =>
                                RepositoryService.repoGetPullRequestFiles({
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                    index: pr.number!,
                                    page,
                                    limit,
                                }),
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
        filters?: {
            period?: {
                startDate?: Date;
                endDate?: Date;
            };
        };
    }): Promise<PullRequestCodeReviewTime[] | null> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );
            if (!repositories) return null;

            this.configureSDK(authDetail);

            const { startDate, endDate } = params?.filters?.period || {};
            const pullRequestCodeReviewTime: PullRequestCodeReviewTime[] = [];

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequestsForRTTM',
                );
                if (!repoInfo) continue;

                try {
                    const prs = await this.paginate<ForgejoPullRequest>(
                        (page, limit) =>
                            RepositoryService.repoListPullRequests({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                state: 'closed',
                                page,
                                limit,
                            }),
                    );

                    for (const pr of prs) {
                        // Filter by date if specified
                        if (startDate && pr.created_at) {
                            if (new Date(pr.created_at) < startDate) continue;
                        }
                        if (endDate && pr.created_at) {
                            if (new Date(pr.created_at) > endDate) continue;
                        }

                        pullRequestCodeReviewTime.push({
                            id: pr.id ?? 0,
                            created_at: pr.created_at ?? '',
                            closed_at: pr.closed_at ?? '',
                        });
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PRs for RTTM from ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return pullRequestCodeReviewTime;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PRs for RTTM',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
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

            this.configureSDK(authDetail);

            // Fetch file metadata and diff in parallel
            const [files, diffContent] = await Promise.all([
                this.paginate<ForgejoChangedFile>((page, limit) =>
                    RepositoryService.repoGetPullRequestFiles({
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                        page,
                        limit,
                    }),
                ),
                RepositoryService.repoDownloadPullDiffOrPatch({
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                    diffType: 'diff',
                }).catch((error) => {
                    this.logger.warn({
                        message: `Failed to fetch diff for PR#${params.prNumber}, continuing without patch data`,
                        context: ForgejoService.name,
                        error,
                    });
                    return '';
                }),
            ]);

            // Parse the unified diff to extract per-file patches
            const patchMap = this.parseUnifiedDiff(diffContent);

            this.logger.log({
                message: `Fetched ${files.length} files with ${patchMap.size} patches for PR#${params.prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    filesCount: files.length,
                    patchesCount: patchMap.size,
                    prNumber: params.prNumber,
                },
            });

            return files.map((f) => ({
                sha: '',
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: patchMap.get(f.filename ?? '') ?? '',
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

            this.configureSDK(authDetail);
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
                    const prs = await this.paginate<ForgejoPullRequest>(
                        (page, limit) =>
                            RepositoryService.repoListPullRequests({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                state: 'all',
                                page,
                                limit,
                            }),
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

            this.configureSDK(authDetail);
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
                    const repoCommits = await this.paginate<ForgejoCommit>(
                        (page, limit) =>
                            RepositoryService.repoGetAllCommits({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                sha: params.filters?.branch,
                                page,
                                limit,
                            }),
                    );

                    for (const commit of repoCommits) {
                        const transformed = this.transformCommit(commit);

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

            this.configureSDK(authDetail);
            const commits = await this.paginate<ForgejoCommit>((page, limit) =>
                RepositoryService.repoGetPullRequestCommits({
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                    page,
                    limit,
                }),
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

            this.configureSDK(authDetail);

            const mergeMethodMap: Record<
                string,
                'merge' | 'squash' | 'rebase'
            > = {
                merge: 'merge',
                squash: 'squash',
                rebase: 'rebase',
            };

            await RepositoryService.repoMergePullRequest({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                body: {
                    Do:
                        mergeMethodMap[params.mergeMethod || 'merge'] ||
                        'merge',
                },
            });

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

            this.configureSDK(authDetail);

            const review = await RepositoryService.repoCreatePullReview({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                body: {
                    event: 'APPROVED',
                    body: params.body || '',
                },
            });

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

    async requestChangesPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
        criticalComments: CommentResult[];
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) throw new Error('No auth details');

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'requestChangesPullRequest',
            );
            if (!repoInfo) throw new Error('Invalid repository name');

            this.configureSDK(authDetail);

            const listOfCriticalIssues = this.getListOfCriticalIssues({
                criticalComments: params.criticalComments,
                owner: repoInfo.owner,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            const requestChangeBodyTitle =
                '# Found critical issues please review the requested changes';

            const formattedBody =
                `${requestChangeBodyTitle}\n\n${listOfCriticalIssues}`.trim();

            const review = await RepositoryService.repoCreatePullReview({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                body: {
                    event: 'REQUEST_CHANGES',
                    body: formattedBody,
                },
            });

            this.logger.log({
                message: `Changed status to requested changes on pull request #${params.prNumber}`,
                context: ForgejoService.name,
                metadata: params,
            });

            return review;
        } catch (error) {
            this.logger.error({
                message: `Error to change status to request changes on pull request #${params.prNumber}`,
                context: ForgejoService.name,
                error,
                metadata: params,
            });
            throw error;
        }
    }

    private getListOfCriticalIssues(params: {
        criticalComments: CommentResult[];
        owner: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): string {
        const { criticalComments, owner, prNumber, repository } = params;

        const criticalIssuesSummaryArray = criticalComments.map(
            (comment) => comment.comment?.suggestion?.oneSentenceSummary,
        );

        const criticalIssuesSummary = criticalIssuesSummaryArray
            .map((issue, index) => `${index + 1}. ${issue}`)
            .join('\n');

        return criticalIssuesSummary;
    }

    async getOrganizations(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<Organization[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            this.configureSDK(authDetail);

            const orgs = await this.paginate<ForgejoOrganization>(
                (page, limit) =>
                    OrganizationService.orgListCurrentUserOrgs({ page, limit }),
            );

            return orgs.map((org) => ({
                id: org.id?.toString() ?? '',
                name: org.name ?? org.username ?? '',
                url: org.avatar_url ?? '',
                selected: false,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting organizations',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getListOfValidReviews(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getListOfValidReviews',
            );
            if (!repoInfo) return null;

            this.configureSDK(authDetail);

            const reviews = await this.paginate<ForgejoPullReview>(
                (page, limit) =>
                    RepositoryService.repoListPullReviews({
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                        page,
                        limit,
                    }),
            );

            // Get comments for each review
            const reviewsWithComments = await Promise.all(
                reviews.map(async (review) => {
                    if (!review.id) return { ...review, comments: [] };

                    try {
                        const comments =
                            await RepositoryService.repoGetPullReviewComments({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                index: params.prNumber,
                                id: review.id,
                            });

                        return {
                            state: review.state,
                            id: review.id?.toString(),
                            comments: comments.map((c) => ({
                                id: c.id?.toString(),
                                body: c.body,
                                outdated: false, // Forgejo doesn't have outdated concept
                                isMinimized: false, // Forgejo doesn't have minimize concept
                            })),
                        };
                    } catch {
                        return {
                            state: review.state,
                            id: review.id?.toString(),
                            comments: [],
                        };
                    }
                }),
            );

            return reviewsWithComments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting list of valid reviews',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<PullRequestsWithChangesRequested[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequestsWithChangesRequested',
            );
            if (!repoInfo) return null;

            this.configureSDK(authDetail);

            // Get all open PRs
            const prs = await this.paginate<ForgejoPullRequest>((page, limit) =>
                RepositoryService.repoListPullRequests({
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    state: 'open',
                    page,
                    limit,
                }),
            );

            const result: PullRequestsWithChangesRequested[] = [];

            // Check each PR for changes requested reviews
            for (const pr of prs) {
                if (!pr.number) continue;

                try {
                    const reviews = await this.paginate<ForgejoPullReview>(
                        (page, limit) =>
                            RepositoryService.repoListPullReviews({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                index: pr.number!,
                                page,
                                limit,
                            }),
                    );

                    // Get the latest review state
                    const latestReview = reviews[reviews.length - 1];
                    if (latestReview?.state === 'REQUEST_CHANGES') {
                        result.push({
                            title: pr.title || '',
                            number: pr.number,
                            reviewDecision:
                                PullRequestReviewState.CHANGES_REQUESTED,
                        });
                    }
                } catch {
                    // Skip PRs we can't get reviews for
                }
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PRs with changes requested',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestReviewThreads(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        // Forgejo doesn't have true review threads like GitHub
        // Return review comments grouped by their review instead
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequestReviewThreads',
            );
            if (!repoInfo) return null;

            this.configureSDK(authDetail);

            const reviews = await this.paginate<ForgejoPullReview>(
                (page, limit) =>
                    RepositoryService.repoListPullReviews({
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                        page,
                        limit,
                    }),
            );

            const allComments: PullRequestReviewComment[] = [];

            for (const review of reviews) {
                if (!review.id) continue;

                try {
                    const comments =
                        await RepositoryService.repoGetPullReviewComments({
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                            id: review.id,
                        });

                    for (const c of comments) {
                        allComments.push({
                            id: c.id,
                            body: c.body ?? '',
                            createdAt: c.created_at,
                            updatedAt: c.updated_at,
                            author: {
                                id: c.user?.id?.toString() ?? '',
                                username: c.user?.login ?? '',
                                name: c.user?.full_name ?? c.user?.login ?? '',
                            },
                        });
                    }
                } catch {
                    // Skip reviews we can't get comments for
                }
            }

            return allComments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PR review threads',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async updateDescriptionInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        summary?: string;
        body?: string;
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

            this.configureSDK(authDetail);

            const description = params.summary ?? params.body;

            const pr = await RepositoryService.repoEditPullRequest({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                body: {
                    body: description,
                },
            });

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

            this.configureSDK(authDetail);
            const reviews = await this.paginate<ForgejoPullReview>(
                (page, limit) =>
                    RepositoryService.repoListPullReviews({
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                        page,
                        limit,
                    }),
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

            const translations = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ReviewComment,
            );

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

            this.configureSDK(authDetail);
            const review = await RepositoryService.repoCreatePullReview({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                body: {
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
            });

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

            this.configureSDK(authDetail);
            const comment = await IssueService.issueCreateComment({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                body: { body: params.body },
            });

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

            this.configureSDK(authDetail);
            const comment = await IssueService.issueEditComment({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                id: params.commentId,
                body: { body: params.body },
            });

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

            this.configureSDK(authDetail);
            // issueGetComments doesn't support pagination, get all at once
            const comments = await IssueService.issueGetComments({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
            });

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

            this.configureSDK(authDetail);

            // Get all reviews for the PR
            const reviews = await this.paginate<ForgejoPullReview>(
                (page, limit) =>
                    RepositoryService.repoListPullReviews({
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                        page,
                        limit,
                    }),
            );

            // Collect all comments from all reviews
            const allComments: PullRequestReviewComment[] = [];
            for (const review of reviews) {
                if (!review.id) continue;
                try {
                    const comments =
                        await RepositoryService.repoGetPullReviewComments({
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                            id: review.id,
                        });
                    for (const c of comments) {
                        // Skip comments from Kody
                        if (hasKodyMarker(c.body)) continue;

                        allComments.push({
                            id: c.id,
                            body: c.body ?? '',
                            createdAt: c.created_at,
                            updatedAt: c.updated_at,
                            author: {
                                id: c.user?.id?.toString() ?? '',
                                username: c.user?.login ?? '',
                                name: c.user?.full_name ?? c.user?.login ?? '',
                            },
                        });
                    }
                } catch (reviewError) {
                    // Skip if we can't get comments for a specific review
                    this.logger.warn({
                        message: `Error fetching comments for review ${review.id}`,
                        context: ForgejoService.name,
                        error: reviewError,
                    });
                }
            }

            return allComments;
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
        inReplyToId?: string;
        commentId?: string;
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

    async markReviewCommentAsResolved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        commentId: string;
    }): Promise<any | null> {
        // Currently forgejo doesn't support marking comments as resolved
        // gitea added this on 01/02/2026 but forgejo hasn't yet
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

            this.configureSDK(authDetail);
            const content = await RepositoryService.repoGetContents({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                filepath: params.path,
                ref: params.ref,
            });

            if (Array.isArray(content)) return null;

            const decodedContent =
                content.encoding === 'base64'
                    ? Buffer.from(content.content || '', 'base64').toString(
                        'utf-8',
                    )
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
            if (error instanceof ApiError && error.status === 404) {
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

            this.configureSDK(authDetail);

            const repoData = await RepositoryService.repoGet({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
            });
            const defaultBranch = repoData.default_branch || 'main';

            const tree = await RepositoryService.getTree({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                sha: defaultBranch,
                recursive: true,
            });

            return (tree.tree || []).map((item) => ({
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

            this.configureSDK(authDetail);

            const path = params.directoryPath || '';
            const contents = await RepositoryService.repoGetContents({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                filepath: path,
            });

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

            this.configureSDK(authDetail);

            const branch = params.filters?.branch || 'main';
            const tree = await RepositoryService.getTree({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                sha: branch,
                recursive: true,
            });

            let files = (tree.tree || [])
                .filter((item) => item.type === 'blob')
                .map((item) => ({
                    path: item.path,
                    type: 'file',
                    filename: item.path?.split('/').pop() || item.path || '',
                    sha: item.sha,
                    size: item.size || 0,
                }));

            if (params.filters?.filePatterns?.length) {
                files = files.filter((f) =>
                    isFileMatchingGlobCaseInsensitive(
                        f.path,
                        params.filters!.filePatterns!,
                    ),
                );
            }

            if (params.filters?.excludePatterns?.length) {
                files = files.filter(
                    (f) =>
                        !isFileMatchingGlob(
                            f.path,
                            params.filters!.excludePatterns!,
                        ),
                );
            }

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

            this.configureSDK(authDetail);
            const user = await UserService.userGet({
                username: params.username,
            });

            return {
                id: user.id!.toString(),
                login: user.login,
                name: user.full_name || user.login,
                email: user.email,
                avatar_url: user.avatar_url,
            };
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
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

            this.configureSDK(authDetail);

            try {
                const user = await UserService.userGet({
                    username: params.userName,
                });
                return {
                    id: user.id!.toString(),
                    login: user.login,
                    name: user.full_name || user.login,
                    email: user.email,
                    avatar_url: user.avatar_url,
                };
            } catch {
                // Not found by username, try search
            }

            const searchResult = await UserService.userSearch({
                q: params.userName,
                limit: 10,
            });
            if (searchResult.data && searchResult.data.length > 0) {
                const user = searchResult.data[0];
                return {
                    id: user.id!.toString(),
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

            this.configureSDK(authDetail);
            const user = await UserService.userGetCurrent();

            return {
                id: user.id!.toString(),
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

            this.configureSDK(authDetail);
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
                    const hooks = await RepositoryService.repoListHooks({
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                    });
                    for (const hook of hooks) {
                        if (hook.config?.url === webhookUrl && hook.id) {
                            await RepositoryService.repoDeleteHook({
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                id: hook.id,
                            });
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

            this.configureSDK(authDetail);
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
                    const existingHooks = await RepositoryService.repoListHooks(
                        {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                        },
                    );
                    const hookExists = existingHooks.some(
                        (hook) => hook.config?.url === webhookUrl,
                    );

                    if (!hookExists) {
                        await RepositoryService.repoCreateHook({
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            body: {
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

            this.configureSDK(authDetail);
            const webhookUrl = this.configService.get<string>(
                'FORGEJO_WEBHOOK_URL',
            );

            const hooks = await RepositoryService.repoListHooks({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
            });
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
    // Reaction Methods
    // ========================================================================

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: Reaction;
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

            this.configureSDK(authDetail);
            await IssueService.issuePostIssueReaction({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
                content: { content: params.reaction },
            });
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
        reaction: Reaction;
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

            this.configureSDK(authDetail);
            await IssueService.issuePostCommentReaction({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                id: params.commentId,
                content: { content: params.reaction },
            });
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
        reactions: Reaction[];
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

            this.configureSDK(authDetail);
            for (const reaction of params.reactions) {
                await IssueService.issueDeleteIssueReaction({
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                    content: { content: reaction },
                });
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
        reactions: Reaction[];
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

            this.configureSDK(authDetail);
            for (const reaction of params.reactions) {
                await IssueService.issueDeleteCommentReaction({
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    id: params.commentId,
                    content: { content: reaction },
                });
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

            this.configureSDK(authDetail);
            const reactions = await IssueService.issueGetIssueReactions({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                index: params.prNumber,
            });

            const counts: Record<string, number> = {};
            for (const r of reactions) {
                if (r.content) {
                    counts[r.content] = (counts[r.content] || 0) + 1;
                }
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
