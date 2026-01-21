import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { GetEnrichedPullRequestsUseCase } from '@libs/code-review/application/use-cases/dashboard/get-enriched-pull-requests.use-case';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    Body,
    Controller,
    Get,
    Headers,
    Inject,
    NotFoundException,
    Post,
    Query,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { BackfillPRsDto } from '../dtos/backfill-prs.dto';
import { EnrichedPullRequestsQueryDto } from '@libs/code-review/dtos/dashboard/enriched-pull-requests-query.dto';
import { PaginatedEnrichedPullRequestsResponse } from '@libs/code-review/dtos/dashboard/paginated-enriched-pull-requests.dto';
import { OnboardingReviewModeSignalsQueryDto } from '../dtos/onboarding-review-mode-signals-query.dto';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';

@Controller('pull-requests')
export class PullRequestController {
    constructor(
        private readonly getEnrichedPullRequestsUseCase: GetEnrichedPullRequestsUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly backfillHistoricalPRsUseCase: BackfillHistoricalPRsUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
    ) {}

    @Get('/executions')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    public async getPullRequestExecutions(
        @Query() query: EnrichedPullRequestsQueryDto,
    ): Promise<PaginatedEnrichedPullRequestsResponse> {
        return await this.getEnrichedPullRequestsUseCase.execute(query);
    }

    @Get('/suggestions')
    public async getSuggestionsByPullRequest(
        @Query('prUrl') prUrl?: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('prNumber') prNumber?: string,
        @Query('format') format: 'json' | 'markdown' = 'json',
        @Query('severity') severity?: string,
        @Query('category') category?: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const key = teamKey || authHeader?.replace(/^Bearer\s+/i, '');
        let organizationId = this.request.user?.organization?.uuid;

        if (!organizationId) {
            if (!key) {
                throw new UnauthorizedException('Team API key required');
            }
            const teamData = await this.teamCliKeyService.validateKey(key);
            if (!teamData?.organization?.uuid) {
                throw new UnauthorizedException(
                    'Invalid or revoked team API key',
                );
            }
            organizationId = teamData.organization.uuid;
        }

        const prEntity = await this.findPrEntity({
            prUrl,
            repositoryId,
            prNumber,
            organizationId,
        });

        if (!prEntity) {
            throw new NotFoundException('Pull request not found');
        }

        const pr = prEntity.toObject();
        return this.buildSuggestionsResponse({
            pr,
            format,
            severity,
            category,
        });
    }

    @Post('/cli/suggestions')
    public async getSuggestionsByPullRequestWithKey(
        @Body('prUrl') prUrl?: string,
        @Body('repositoryId') repositoryId?: string,
        @Body('prNumber') prNumber?: string,
        @Body('format') format: 'json' | 'markdown' = 'json',
        @Body('severity') severity?: string,
        @Body('category') category?: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        return this.getSuggestionsWithTeamKey({
            prUrl,
            repositoryId,
            prNumber,
            format,
            severity,
            category,
            teamKey,
            authHeader,
        });
    }

    @Get('/cli/suggestions')
    public async getSuggestionsByPullRequestWithKeyGet(
        @Query('prUrl') prUrl?: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('prNumber') prNumber?: string,
        @Query('format') format: 'json' | 'markdown' = 'json',
        @Query('severity') severity?: string,
        @Query('category') category?: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        return this.getSuggestionsWithTeamKey({
            prUrl,
            repositoryId,
            prNumber,
            format,
            severity,
            category,
            teamKey,
            authHeader,
        });
    }

    private async getSuggestionsWithTeamKey(params: {
        prUrl?: string;
        repositoryId?: string;
        prNumber?: string;
        format?: 'json' | 'markdown';
        severity?: string;
        category?: string;
        teamKey?: string;
        authHeader?: string;
    }) {
        const {
            prUrl,
            repositoryId,
            prNumber,
            format = 'json',
            severity,
            category,
            teamKey,
            authHeader,
        } = params;

        const key = teamKey || authHeader?.replace(/^Bearer\s+/i, '');
        if (!key) {
            throw new UnauthorizedException('Team API key required');
        }

        const teamData = await this.teamCliKeyService.validateKey(key);
        if (!teamData?.organization?.uuid) {
            throw new UnauthorizedException('Invalid or revoked team API key');
        }

        const prEntity = await this.findPrEntity({
            prUrl,
            repositoryId,
            prNumber,
            organizationId: teamData.organization.uuid,
        });

        if (!prEntity) {
            throw new NotFoundException('Pull request not found');
        }

        const pr = prEntity.toObject();
        return this.buildSuggestionsResponse({
            pr,
            format,
            severity,
            category,
        });
    }

    private async findPrEntity(params: {
        prUrl?: string;
        repositoryId?: string;
        prNumber?: string;
        organizationId: string;
    }) {
        const { prUrl, repositoryId, prNumber, organizationId } = params;

        // Try by URL first
        if (prUrl) {
            const direct = await this.pullRequestsService.findOne({
                url: prUrl,
                organizationId,
            });
            if (direct) return direct;

            // Fallback: parse PR number and repo from URL
            const match = prUrl.match(
                /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
            );
            if (match) {
                const repoFullName = `${match[1]}/${match[2]}`;
                const parsedNumber = Number(match[3]);
                const byFullName = await this.pullRequestsService.findOne({
                    'number': parsedNumber,
                    organizationId,
                    'repository.fullName': repoFullName,
                } as any);
                if (byFullName) return byFullName;
            }

            // If we got a PR URL but couldn't resolve, return null (404 later)
            return null;
        }

        const parsedPrNumber = prNumber ? parseInt(prNumber, 10) : NaN;
        if (!repositoryId || Number.isNaN(parsedPrNumber)) {
            return null;
        }

        // Try by repo.id
        const byId = await this.pullRequestsService.findOne({
            'number': parsedPrNumber,
            organizationId,
            'repository.id': repositoryId,
        } as any);
        if (byId) return byId;

        // Fallback: try repo fullName if caller passed that in repositoryId
        const byFullNameId = await this.pullRequestsService.findOne({
            'number': parsedPrNumber,
            organizationId,
            'repository.fullName': repositoryId,
        } as any);
        if (byFullNameId) return byFullNameId;

        return null;
    }

    private buildSuggestionsResponse(params: {
        pr: any;
        format: 'json' | 'markdown';
        severity?: string;
        category?: string;
    }) {
        const { pr, format, severity, category } = params;

        const severityFilter = severity
            ? new Set(
                  severity
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
              )
            : null;
        const categoryFilter = category
            ? new Set(
                  category
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
              )
            : null;

        const matchesFilters = (s: any) => {
            const sevOk = severityFilter
                ? severityFilter.has(s.severity)
                : true;
            const catOk = categoryFilter ? categoryFilter.has(s.label) : true;
            return sevOk && catOk;
        };

        const fileSuggestions = (pr.files || []).flatMap((file) =>
            (file.suggestions || [])
                .filter(
                    (s) =>
                        s.deliveryStatus === DeliveryStatus.SENT &&
                        matchesFilters(s),
                )
                .map((s) => ({
                    ...s,
                    filePath: file.path,
                })),
        );

        const prLevelSuggestions = (pr.prLevelSuggestions || []).filter(
            (s) =>
                s.deliveryStatus === DeliveryStatus.SENT && matchesFilters(s),
        );

        const payload = {
            prNumber: pr.number,
            repositoryId: pr.repository?.id,
            repositoryFullName: pr.repository?.fullName,
            suggestions: {
                files: fileSuggestions,
                prLevel: prLevelSuggestions,
            },
        };

        if (format === 'markdown') {
            const header = `# Suggestions for PR #${payload.prNumber} (${payload.repositoryFullName || payload.repositoryId || ''})`;
            const filtersInfo = [
                severityFilter
                    ? `severity in [${[...severityFilter].join(', ')}]`
                    : null,
                categoryFilter
                    ? `category in [${[...categoryFilter].join(', ')}]`
                    : null,
            ]
                .filter(Boolean)
                .join(' | ');

            const filesSection = fileSuggestions.length
                ? fileSuggestions
                      .map(
                          (s) =>
                              `- [File] ${s.filePath} — ${s.oneSentenceSummary || s.label || ''}\n  - Severity: ${s.severity || ''}\n  - Category: ${s.label || ''}\n  - Status: ${s.deliveryStatus || ''}\n  - Lines: ${s.relevantLinesStart ?? ''}-${s.relevantLinesEnd ?? ''}\n  - Content:\n\n${'```'}
${s.suggestionContent || s.improvedCode || ''}
${'```'}`,
                      )
                      .join('\n\n')
                : '_No file-level suggestions sent_';

            const prLevelSection = prLevelSuggestions.length
                ? prLevelSuggestions
                      .map(
                          (s) =>
                              `- [PR] ${s.oneSentenceSummary || s.label || ''}\n  - Severity: ${s.severity || ''}\n  - Category: ${s.label || ''}\n  - Status: ${s.deliveryStatus || ''}\n  - Content:\n\n${'```'}
${s.suggestionContent || ''}
${'```'}`,
                      )
                      .join('\n\n')
                : '_No PR-level suggestions sent_';

            const markdown = `${header}${filtersInfo ? `\n\n_Filters: ${filtersInfo}_` : ''}\n\n## File suggestions\n${filesSection}\n\n## PR-level suggestions\n${prLevelSection}`;
            return { markdown };
        }

        return payload;
    }

    @Get('/onboarding-signals')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    public async getOnboardingSignals(
        @Query() query: OnboardingReviewModeSignalsQueryDto,
    ) {
        const organizationId = this.request.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('No organization found in request');
        }

        const { teamId, repositoryIds, limit } = query;

        const organizationAndTeamData = {
            organizationId,
            teamId,
        };

        return this.pullRequestsService.getOnboardingReviewModeSignals({
            organizationAndTeamData,
            repositoryIds,
            limit,
        });
    }

    // NOT USED IN WEB - INTERNAL USE ONLY
    @Post('/backfill')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.PullRequests,
        }),
    )
    public async backfillHistoricalPRs(@Body() body: BackfillPRsDto) {
        const { teamId, repositoryIds, startDate, endDate } = body;
        const organizationId = this.request.user?.organization?.uuid;

        const organizationAndTeamData = {
            organizationId,
            teamId,
        };

        let repositories = await this.codeManagementService.getRepositories({
            organizationAndTeamData,
        });

        if (!repositories || repositories.length === 0) {
            return {
                success: false,
                message: 'No repositories found',
            };
        }

        repositories = repositories.filter(
            (r: any) => r && (r.selected === true || r.isSelected === true),
        );

        if (repositoryIds && repositoryIds.length > 0) {
            repositories = repositories.filter(
                (r: any) =>
                    repositoryIds.includes(r.id) ||
                    repositoryIds.includes(String(r.id)),
            );
        }

        if (repositories.length === 0) {
            return {
                success: false,
                message: 'No selected repositories found',
            };
        }

        setImmediate(() => {
            this.backfillHistoricalPRsUseCase
                .execute({
                    organizationAndTeamData,
                    repositories: repositories.map((r: any) => ({
                        id: String(r.id),
                        name: r.name,
                        fullName:
                            r.fullName ||
                            r.full_name ||
                            `${r.organizationName || ''}/${r.name}`,
                    })),
                    startDate,
                    endDate,
                })
                .catch((error) => {
                    console.error('Error during manual PR backfill:', error);
                });
        });

        return {
            success: true,
            message: 'PR backfill started in background',
            repositoriesCount: repositories.length,
        };
    }
}
