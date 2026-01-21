import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { AuthenticatedRateLimiterService } from '@libs/cli-review/infrastructure/services/authenticated-rate-limiter.service';
import { TrialRateLimiterService } from '@libs/cli-review/infrastructure/services/trial-rate-limiter.service';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    HttpException,
    HttpStatus,
    Inject,
    Post,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import {
    CliReviewRequestDto,
    TrialCliReviewRequestDto,
} from '../dtos/cli-review.dto';

/**
 * Controller for CLI code review endpoints
 * Provides both authenticated and trial review capabilities
 */
@Controller('cli')
export class CliReviewController {
    constructor(
        private readonly executeCliReviewUseCase: ExecuteCliReviewUseCase,
        private readonly trialRateLimiter: TrialRateLimiterService,
        private readonly authenticatedRateLimiter: AuthenticatedRateLimiterService,
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
    ) {}

    /**
     * Validate a Team CLI key (health check for CLI)
     */
    @Get('validate-key')
    async validateKey(
        @Headers('x-team-key') teamKey: string,
        @Headers('authorization') authHeader: string,
        @Res() res,
    ) {
        const payload = await this.validateKeyInternal(teamKey, authHeader);
        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    /**
     * POST alias for clients that send POST
     */
    @Post('validate-key')
    async validateKeyPost(
        @Headers('x-team-key') teamKey: string,
        @Headers('authorization') authHeader: string,
        @Res() res,
    ) {
        const payload = await this.validateKeyInternal(teamKey, authHeader);
        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    private async validateKeyInternal(teamKey?: string, authHeader?: string) {
        const key = teamKey || authHeader?.replace(/^Bearer\s+/i, '');

        const buildPayload = (base: any) => ({
            ...base,
            data: {
                ...base,
            },
        });

        const buildInvalidPayload = (error: string) =>
            buildPayload({
                valid: false,
                error,
                team: {
                    id: null,
                    name: '',
                },
                organization: {
                    id: null,
                    name: '',
                },
                user: {
                    email: '',
                    name: '',
                },
            });

        if (!key) {
            return buildInvalidPayload(
                'Team API key required. Provide via X-Team-Key or Authorization: Bearer header.',
            );
        }

        const teamData = await this.teamCliKeyService.validateKey(key);

        if (!teamData) {
            return buildInvalidPayload('Invalid or revoked team API key');
        }

        const { team, organization } = teamData;

        const safeTeam: any = team ?? {};
        const safeOrg: any = organization ?? {};
        const safeTeamName =
            typeof safeTeam.name === 'string' ? safeTeam.name : '';
        const safeOrgName =
            typeof safeOrg.name === 'string' ? safeOrg.name : '';

        const result = {
            valid: !!(safeTeam.uuid && safeOrg.uuid),
            teamId: safeTeam.uuid ?? null,
            organizationId: safeOrg.uuid ?? null,
            teamName: safeTeamName,
            organizationName: safeOrgName,
            team: {
                id: safeTeam.uuid ?? null,
                name: safeTeamName,
            },
            organization: {
                id: safeOrg.uuid ?? null,
                name: safeOrgName,
            },
            user: {
                email: '',
                name: '',
            },
            // compat fields some clients expect
            email: '',
            userEmail: '',
        };

        if (!result.valid) {
            result['error'] = 'Invalid or incomplete team API key';
        }

        return buildPayload(result);
    }

    /**
     * CLI code review endpoint with Team API Key authentication
     * No user authentication required - uses team key instead
     */
    @Post('review')
    async review(
        @Body() body: CliReviewRequestDto,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        // 1. Extract team key from headers
        const key = teamKey || authHeader?.replace(/^Bearer\s+/i, '');

        if (!key) {
            throw new UnauthorizedException(
                'Team API key required. Provide via X-Team-Key header or Authorization: Bearer header.',
            );
        }

        // 2. Validate team key
        const teamData = await this.teamCliKeyService.validateKey(key);

        if (!teamData) {
            throw new UnauthorizedException('Invalid or revoked team API key');
        }

        const { team, organization } = teamData;
        const organizationAndTeamData = {
            organizationId: organization.uuid,
            teamId: team.uuid,
        };

        // 3. Check rate limit for authenticated team
        const rateLimitResult =
            await this.authenticatedRateLimiter.checkRateLimit(team.uuid);

        if (!rateLimitResult.allowed) {
            throw new HttpException(
                {
                    message:
                        'Rate limit exceeded for this team. Please try again later.',
                    remaining: rateLimitResult.remaining,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                    limit: 1000,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        // 4. Validate domain of email (if configured)
        if (body.userEmail) {
            const allowedDomains = team.cliConfig?.allowedDomains || [];

            if (allowedDomains.length > 0) {
                const isValidDomain = allowedDomains.some((domain: string) =>
                    body.userEmail.endsWith(domain),
                );

                if (!isValidDomain) {
                    throw new ForbiddenException(
                        `Email must be from allowed domains: ${allowedDomains.join(', ')}`,
                    );
                }
            }
        }

        // 5. Execute review
        return this.executeCliReviewUseCase.execute({
            organizationAndTeamData,
            input: {
                diff: body.diff,
                config: body.config,
            },
            isTrialMode: false,
            userEmail: body.userEmail,
            gitContext: {
                remote: body.gitRemote,
                branch: body.branch,
                commitSha: body.commitSha,
                inferredPlatform: body.inferredPlatform,
                cliVersion: body.cliVersion,
            },
        });
    }

    /**
     * Trial CLI code review endpoint (no authentication required)
     * Rate limited by device fingerprint
     */
    @Post('trial/review')
    async trialReview(@Body() body: TrialCliReviewRequestDto) {
        if (!body.fingerprint) {
            throw new HttpException(
                'Device fingerprint is required for trial reviews',
                HttpStatus.BAD_REQUEST,
            );
        }

        // Check rate limit
        const rateLimitResult = await this.trialRateLimiter.checkRateLimit(
            body.fingerprint,
        );

        if (!rateLimitResult.allowed) {
            throw new HttpException(
                {
                    message: 'Rate limit exceeded. Please try again later.',
                    remaining: rateLimitResult.remaining,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                    limit: 2,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        // Execute review with trial defaults (no auth required)
        const result = await this.executeCliReviewUseCase.execute({
            organizationAndTeamData: {
                organizationId: 'trial',
                teamId: 'trial',
            },
            input: {
                diff: body.diff,
                config: body.config,
            },
            isTrialMode: true,
        });

        // Add rate limit info to response
        return {
            ...result,
            rateLimit: {
                remaining: rateLimitResult.remaining,
                limit: 2,
                resetAt: rateLimitResult.resetAt?.toISOString(),
            },
        };
    }
}
