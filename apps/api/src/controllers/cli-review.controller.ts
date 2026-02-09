import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { AuthenticatedRateLimiterService } from '@libs/cli-review/infrastructure/services/authenticated-rate-limiter.service';
import { TrialRateLimiterService } from '@libs/cli-review/infrastructure/services/trial-rate-limiter.service';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    HttpException,
    HttpStatus,
    Inject,
    Post,
    Query,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    ApiBadRequestResponse,
    ApiHeader,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiTooManyRequestsResponse,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ApiErrorDto } from '../dtos/api-error.dto';
import {
    CliReviewRequestDto,
    TrialCliReviewRequestDto,
} from '../dtos/cli-review.dto';
import {
    CliReviewRateLimitErrorDto,
    CliReviewResponseDto,
    CliValidateKeyResponseDto,
    TrialCliReviewResponseDto,
} from '../dtos/cli-review.response.dto';

/**
 * Controller for CLI code review endpoints
 * Provides both authenticated and trial review capabilities
 */
@ApiTags('CLI Review')
@ApiStandardResponses()
@Public()
@Controller('cli')
export class CliReviewController {
    private readonly jwtConfig: JWT;

    constructor(
        private readonly executeCliReviewUseCase: ExecuteCliReviewUseCase,
        private readonly trialRateLimiter: TrialRateLimiterService,
        private readonly authenticatedRateLimiter: AuthenticatedRateLimiterService,
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {
        this.jwtConfig = this.configService.get<JWT>('jwtConfig');
    }

    /**
     * Validate a Team CLI key (health check for CLI)
     */
    @Get('validate-key')
    @ApiOperation({
        summary: 'Validate team CLI key',
        description:
            'Validates a Team CLI key sent via `x-team-key` or `Authorization: Bearer <team-key>`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CliValidateKeyResponseDto })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing team CLI key',
        type: CliValidateKeyResponseDto,
    })
    async validateKey(
        @Headers('x-team-key') teamKey: string,
        @Headers('authorization') authHeader: string,
        @Query('teamId') queryTeamId: string,
        @Res() res,
    ) {
        const payload = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );
        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    /**
     * POST alias for clients that send POST
     */
    @Post('validate-key')
    @ApiOperation({
        summary: 'Validate team CLI key (POST)',
        description:
            'POST alias for validate-key. Accepts `x-team-key` or `Authorization: Bearer <team-key>`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CliValidateKeyResponseDto })
    @ApiUnauthorizedResponse({
        description: 'Invalid or missing team CLI key',
        type: CliValidateKeyResponseDto,
    })
    async validateKeyPost(
        @Headers('x-team-key') teamKey: string,
        @Headers('authorization') authHeader: string,
        @Query('teamId') queryTeamId: string,
        @Res() res,
    ) {
        const payload = await this.validateKeyInternal(
            teamKey,
            authHeader,
            queryTeamId,
        );
        return res.status(payload.valid ? 200 : 401).json(payload);
    }

    private async validateKeyInternal(
        teamKey?: string,
        authHeader?: string,
        queryTeamId?: string,
    ) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

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

        // Route 1: Team CLI key (via X-Team-Key or Bearer with kodus_ prefix)
        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;

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
                email: '',
                userEmail: '',
            };

            if (!result.valid) {
                result['error'] = 'Invalid or incomplete team API key';
            }

            return buildPayload(result);
        }

        // Route 2: JWT Bearer token
        if (bearerToken) {
            let jwtPayload: any;
            try {
                jwtPayload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                return buildInvalidPayload('Invalid or expired JWT token');
            }

            const user = await this.authService.validateUser({
                email: jwtPayload.email,
            });

            if (
                !user ||
                user.role !== jwtPayload.role ||
                user.status !== jwtPayload.status ||
                user.status === STATUS.REMOVED
            ) {
                return buildInvalidPayload(
                    'User account is inactive or removed',
                );
            }

            if (!queryTeamId) {
                return buildInvalidPayload(
                    'teamId query parameter is required when using JWT authentication',
                );
            }

            const team = await this.teamService.findById(queryTeamId);

            if (!team) {
                return buildInvalidPayload(
                    'Team not found for the provided teamId',
                );
            }

            if (team.organization?.uuid !== jwtPayload.organizationId) {
                return buildInvalidPayload(
                    'Team does not belong to the authenticated organization',
                );
            }

            const safeTeamName =
                typeof team.name === 'string' ? team.name : '';
            const safeOrgName =
                typeof team.organization?.name === 'string'
                    ? team.organization.name
                    : '';

            return buildPayload({
                valid: true,
                teamId: team.uuid,
                organizationId: jwtPayload.organizationId,
                teamName: safeTeamName,
                organizationName: safeOrgName,
                team: {
                    id: team.uuid,
                    name: safeTeamName,
                },
                organization: {
                    id: jwtPayload.organizationId,
                    name: safeOrgName,
                },
                user: {
                    email: jwtPayload.email ?? '',
                    name: '',
                },
                email: jwtPayload.email ?? '',
                userEmail: jwtPayload.email ?? '',
            });
        }

        // No auth provided
        return buildInvalidPayload(
            'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
        );
    }

    /**
     * CLI code review endpoint with Team API Key authentication
     * No user authentication required - uses team key instead
     */
    @Post('review')
    @ApiOperation({
        summary: 'Run CLI code review',
        description:
            'Runs a code review using a Team CLI key passed via `x-team-key` or `Authorization: Bearer <team-key>`.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiOkResponse({ type: CliReviewResponseDto })
    @ApiTooManyRequestsResponse({
        description: 'Rate limit exceeded',
        type: CliReviewRateLimitErrorDto,
    })
    async review(
        @Body() body: CliReviewRequestDto,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('teamId') queryTeamId?: string,
    ) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

        let organizationAndTeamData: {
            organizationId: string;
            teamId: string;
        };
        let teamForRateLimit: { uuid: string; cliConfig?: any };

        // Route 1: Team CLI key (via X-Team-Key header or Bearer with kodus_ prefix)
        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;

            if (!key) {
                throw new UnauthorizedException(
                    'Team API key required. Provide via X-Team-Key header or Authorization: Bearer header.',
                );
            }

            const teamData = await this.teamCliKeyService.validateKey(key);

            if (!teamData) {
                throw new UnauthorizedException(
                    'Invalid or revoked team API key',
                );
            }

            const { team, organization } = teamData;

            if (!team?.uuid || !organization?.uuid) {
                throw new UnauthorizedException(
                    'Invalid or incomplete team API key',
                );
            }

            organizationAndTeamData = {
                organizationId: organization.uuid,
                teamId: team.uuid,
            };
            teamForRateLimit = {
                uuid: team.uuid,
                cliConfig: team.cliConfig,
            };
        }
        // Route 2: JWT Bearer token
        else if (bearerToken) {
            let payload: any;
            try {
                payload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                throw new UnauthorizedException(
                    'Invalid or expired JWT token',
                );
            }

            const user = await this.authService.validateUser({
                email: payload.email,
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            if (user.role !== payload.role) {
                throw new UnauthorizedException('User role has changed');
            }

            if (
                user.status !== payload.status ||
                user.status === STATUS.REMOVED
            ) {
                throw new UnauthorizedException(
                    'User account is inactive or removed',
                );
            }

            if (!queryTeamId) {
                throw new BadRequestException(
                    'teamId query parameter is required when using JWT authentication',
                );
            }

            const team = await this.teamService.findById(queryTeamId);

            if (!team) {
                throw new UnauthorizedException(
                    'Team not found for the provided teamId',
                );
            }

            if (team.organization?.uuid !== payload.organizationId) {
                throw new ForbiddenException(
                    'Team does not belong to the authenticated organization',
                );
            }

            organizationAndTeamData = {
                organizationId: payload.organizationId,
                teamId: team.uuid,
            };
            teamForRateLimit = {
                uuid: team.uuid,
                cliConfig: team.cliConfig,
            };
        }
        // No auth provided
        else {
            throw new UnauthorizedException(
                'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
            );
        }

        // 3. Check rate limit for authenticated team
        const rateLimitResult =
            await this.authenticatedRateLimiter.checkRateLimit(
                teamForRateLimit.uuid,
            );

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
            const allowedDomains =
                teamForRateLimit.cliConfig?.allowedDomains || [];

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
    @ApiOperation({
        summary: 'Run trial CLI code review',
        description:
            'Runs a trial code review (no auth). Requires `fingerprint` and is rate-limited by device.',
    })
    @ApiOkResponse({ type: TrialCliReviewResponseDto })
    @ApiBadRequestResponse({
        description: 'Missing device fingerprint',
        type: ApiErrorDto,
    })
    @ApiTooManyRequestsResponse({
        description: 'Rate limit exceeded',
        type: CliReviewRateLimitErrorDto,
    })
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
