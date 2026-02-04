import { Inject, Injectable } from '@nestjs/common';

import {
    TOKEN_USAGE_SERVICE_TOKEN,
    ITokenUsageService,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    TokenUsageQueryContract,
    UsageByPrResultContract,
    DailyUsageByPrResultContract,
    DailyUsageByDeveloperResultContract,
    UsageByDeveloperResultContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestUserMapping } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

@Injectable()
export class TokensByDeveloperUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
    ) {}

    execute(
        query: TokenUsageQueryContract,
        daily: false,
    ): Promise<UsageByDeveloperResultContract[]>;

    execute(
        query: TokenUsageQueryContract,
        daily: true,
    ): Promise<DailyUsageByDeveloperResultContract[]>;

    async execute(
        query: TokenUsageQueryContract,
        daily: boolean,
    ): Promise<
        DailyUsageByDeveloperResultContract[] | UsageByDeveloperResultContract[]
    > {
        const usages = daily
            ? await this.tokenUsageService.getDailyUsageByPr(query)
            : await this.tokenUsageService.getUsageByPr(query);

        const pullRequestsMap = await this.getPullRequestsMap(
            usages,
            query.organizationId,
        );

        const mapped = this.mapUsagesWithDevelopers(usages, pullRequestsMap);

        if (query.developer) {
            return mapped.filter(
                (usage) => usage.developer === query.developer,
            );
        }

        if (!daily) {
            return this.groupByDeveloperAndModel(mapped);
        }

        return mapped;
    }

    private async getPullRequestsMap(
        usages: { prNumber: number }[],
        organizationId: string,
    ): Promise<Map<number, IPullRequestUserMapping>> {
        // Get unique PR numbers
        const uniquePrNumbers = [...new Set(usages.map((u) => u.prNumber))];

        if (uniquePrNumbers.length === 0) {
            return new Map();
        }

        // PERF: Batch fetch all PRs in a single query instead of N+1
        const pullRequests = await this.pullRequestsService.findManyByNumbers(
            uniquePrNumbers,
            organizationId,
        );

        // Build map from results
        const pullRequestsMap = new Map<number, IPullRequestUserMapping>();
        for (const pr of pullRequests) {
            pullRequestsMap.set(pr.number, pr);
        }

        return pullRequestsMap;
    }

    private mapUsagesWithDevelopers(
        usages: (UsageByPrResultContract | DailyUsageByPrResultContract)[],
        pullRequestsMap: Map<number, IPullRequestUserMapping>,
    ) {
        return usages.map((usage) => {
            const pr = pullRequestsMap.get(usage.prNumber);
            const developer = pr?.user?.username || 'unknown';

            return {
                ...usage,
                developer,
            };
        });
    }

    private groupByDeveloperAndModel(
        usages: UsageByDeveloperResultContract[],
    ): UsageByDeveloperResultContract[] {
        const grouped = new Map<string, UsageByDeveloperResultContract>();

        for (const usage of usages) {
            const { developer, model, ...rest } = usage;
            const key = `${developer}-${model}`;

            if (!grouped.has(key)) {
                grouped.set(key, { developer, model, ...rest });
            } else {
                const existing = grouped.get(key)!;

                existing.input += rest.input;
                existing.output += rest.output;
                existing.total += rest.total;
                existing.outputReasoning += rest.outputReasoning;

                grouped.set(key, existing);
            }
        }

        return Array.from(grouped.values());
    }
}
