import { createLogger } from '@kodus/flow';
import { CostEstimateUseCase } from '@libs/analytics/application/use-cases/usage/cost-estimate.use-case';
import { TokenPricingUseCase } from '@libs/analytics/application/use-cases/usage/token-pricing.use-case';
import { TokensByDeveloperUseCase } from '@libs/analytics/application/use-cases/usage/tokens-developer.use-case';
import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    CostEstimateContract,
    DailyUsageByDeveloperResultContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TokenUsageQueryContract,
    UsageByDeveloperResultContract,
    UsageByPrResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    BadRequestException,
    Controller,
    Get,
    Inject,
    Query,
    Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    TokenPricingQueryDto,
    TokenUsageQueryDto,
} from '../dtos/token-usage.dto';
import { ApiObjectResponseDto } from '../dtos/api-response.dto';
import {
    CostEstimateResponseDto,
    DailyUsageByDeveloperResponseDto,
    DailyUsageByPrResponseDto,
    DailyUsageResponseDto,
    UsageByDeveloperResponseDto,
    UsageByPrResponseDto,
    UsageSummaryResponseDto,
} from '../dtos/token-usage-response.dto';

@ApiTags('Token Usage')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller({ path: 'usage', scope: Scope.REQUEST })
export class TokenUsageController {
    private readonly logger = createLogger(TokenUsageController.name);

    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly tokensByDeveloperUseCase: TokensByDeveloperUseCase,
        private readonly tokenPricingUseCase: TokenPricingUseCase,
        private readonly costEstimateUseCase: CostEstimateUseCase,
    ) {}

    @Get('tokens/summary')
    @ApiOperation({
        summary: 'Get token usage summary',
        description: 'Return aggregated token usage for the selected period.',
    })
    @ApiOkResponse({ type: UsageSummaryResponseDto })
    async getSummary(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageSummaryContract> {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            const mapped = this.mapDtoToContract(query, organizationId);
            return this.tokenUsageService.getSummary(mapped);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token usage summary',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return {} as UsageSummaryContract;
        }
    }

    @Get('tokens/daily')
    @ApiOperation({
        summary: 'Get daily token usage',
        description: 'Return daily token usage for the selected period.',
    })
    @ApiOkResponse({ type: DailyUsageResponseDto })
    async getDaily(
        @Query() query: TokenUsageQueryDto,
    ): Promise<DailyUsageResultContract[]> {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            const mapped = this.mapDtoToContract(query, organizationId);
            return this.tokenUsageService.getDailyUsage(mapped);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching daily token usage',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return [];
        }
    }

    @Get('tokens/by-pr')
    @ApiOperation({
        summary: 'Get token usage by PR',
        description: 'Return token usage aggregated by pull request.',
    })
    @ApiOkResponse({ type: UsageByPrResponseDto })
    async getUsageByPr(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageByPrResultContract[]> {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            const mapped = this.mapDtoToContract(query, organizationId);
            return await this.tokenUsageService.getUsageByPr(mapped);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token usage by PR',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return [];
        }
    }

    @Get('tokens/daily-by-pr')
    @ApiOperation({
        summary: 'Get daily token usage by PR',
        description: 'Return daily token usage aggregated by pull request.',
    })
    @ApiOkResponse({ type: DailyUsageByPrResponseDto })
    async getDailyUsageByPr(
        @Query() query: TokenUsageQueryDto,
    ): Promise<DailyUsageByPrResultContract[]> {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            const mapped = this.mapDtoToContract(query, organizationId);
            return await this.tokenUsageService.getDailyUsageByPr(mapped);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching daily token usage by PR',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return [];
        }
    }

    @Get('tokens/by-developer')
    @ApiOperation({
        summary: 'Get token usage by developer',
        description: 'Return token usage aggregated by developer.',
    })
    @ApiOkResponse({ type: UsageByDeveloperResponseDto })
    async getUsageByDeveloper(
        @Query() query: TokenUsageQueryDto,
    ): Promise<UsageByDeveloperResultContract[]> {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            const mapped = this.mapDtoToContract(query, organizationId);
            return await this.tokensByDeveloperUseCase.execute(mapped, false);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token usage by developer',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return [];
        }
    }

    @Get('tokens/daily-by-developer')
    @ApiOperation({
        summary: 'Get daily token usage by developer',
        description: 'Return daily token usage aggregated by developer.',
    })
    @ApiOkResponse({ type: DailyUsageByDeveloperResponseDto })
    async getDailyByDeveloper(
        @Query() query: TokenUsageQueryDto,
    ): Promise<DailyUsageByDeveloperResultContract[]> {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            const mapped = this.mapDtoToContract(query, organizationId);
            return await this.tokensByDeveloperUseCase.execute(mapped, true);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching daily token usage by developer',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return [];
        }
    }

    @Get('tokens/pricing')
    @ApiOperation({
        summary: 'Get token pricing',
        description: 'Return token pricing for model/provider.',
    })
    @ApiOkResponse({ type: ApiObjectResponseDto })
    async getPricing(@Query() query: TokenPricingQueryDto) {
        try {
            const organizationId = this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId not found in request',
                );
            }

            return await this.tokenPricingUseCase.execute(
                query.model,
                query.provider,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token pricing',
                error,
                context: TokenUsageController.name,
                metadata: { query },
            });
            return {};
        }
    }

    @Get('cost-estimate')
    @ApiOperation({
        summary: 'Get cost estimate',
        description: 'Return estimated token costs for the organization.',
    })
    @ApiOkResponse({ type: CostEstimateResponseDto })
    async getCostEstimate(): Promise<CostEstimateContract> {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }

        try {
            return await this.costEstimateUseCase.execute(organizationId);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching cost estimate',
                error,
                context: TokenUsageController.name,
                metadata: { organizationId },
            });
            return {
                estimatedMonthlyCost: 0,
                costPerDeveloper: 0,
                developerCount: 0,
                tokenUsage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                },
                periodDays: 14,
                projectionDays: 30,
            };
        }
    }

    private mapDtoToContract(
        query: TokenUsageQueryDto,
        organizationId: string,
    ): TokenUsageQueryContract {
        const start = new Date(query.startDate);
        const end = new Date(query.endDate);

        // Detect if the original strings include an explicit time component
        const startDateHasTime =
            query.startDate?.includes('T') || query.startDate?.includes(':');
        const endDateHasTime =
            query.endDate?.includes('T') || query.endDate?.includes(':');

        // Normalize date-only inputs to UTC day boundaries
        if (!Number.isNaN(start.getTime()) && !startDateHasTime) {
            start.setUTCHours(0, 0, 0, 0);
        }
        if (!Number.isNaN(end.getTime()) && !endDateHasTime) {
            end.setUTCHours(23, 59, 59, 999);
        }

        const normalized = query.byok.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            throw new BadRequestException(
                `byok must be a 'true' or 'false' string`,
            );
        }
        const byokBoolean = normalized === 'true';

        return {
            organizationId,
            prNumber: query.prNumber,
            start,
            end,
            timezone: query.timezone || 'UTC',
            developer: query.developer,
            models: query.models,
            byok: byokBoolean,
        };
    }
}
