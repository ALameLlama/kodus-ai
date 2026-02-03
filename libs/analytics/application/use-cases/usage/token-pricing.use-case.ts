import { createLogger } from '@kodus/flow';
import { BYOKProvider } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { Axios } from 'axios';

import { CacheService } from '@libs/core/cache/cache.service';

type ModelInfo = {
    id: string;
    pricing: {
        prompt: number;
        completion: number;
        internal_reasoning: number;
    };
};

@Injectable()
export class TokenPricingUseCase {
    private readonly logger = createLogger(TokenPricingUseCase.name);
    private readonly axios: Axios;

    constructor(private readonly cacheService: CacheService) {
        this.axios = new Axios({
            baseURL: 'https://openrouter.ai/api/v1',
            headers: {
                'Authorization': `Bearer ${process.env.API_OPENROUTER_KEY}`,
                'Content-Type': 'application/json',
            },
        });
    }

    async execute(model: string, provider?: string) {
        try {
            return await this.getModelInfo(model, provider);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token pricing',
                error,
                context: TokenPricingUseCase.name,
            });
            return {} as ModelInfo;
        }
    }

    private async getPricingData() {
        const cached =
            await this.cacheService.getFromCache<ModelInfo[]>('token-pricing');

        if (cached) {
            return cached;
        }

        const response = await this.axios.get('/models');

        if (!response.data) {
            throw new Error('No pricing data found');
        }

        const parsed = JSON.parse(response.data) as {
            data: ModelInfo[];
        };

        if (!parsed.data || parsed.data.length === 0) {
            throw new Error('No pricing data found');
        }

        await this.cacheService.addToCache(
            'token-pricing',
            parsed.data,
            24 * 60 * 60,
        );

        return parsed.data;
    }

    private async getProviderModels(provider: string) {
        let mappedProvider = provider;
        switch (provider) {
            case BYOKProvider.GOOGLE_VERTEX:
            case BYOKProvider.GOOGLE_GEMINI:
                mappedProvider = 'google';
                break;
            case BYOKProvider.NOVITA:
            case BYOKProvider.OPENAI_COMPATIBLE:
            case BYOKProvider.OPEN_ROUTER:
                mappedProvider = 'all';
                break;
            default:
                break;
        }

        const allModels = await this.getPricingData();
        const providerModels =
            !mappedProvider || mappedProvider === 'all'
                ? allModels
                : allModels.filter((m) =>
                      m.id
                          .toLowerCase()
                          .startsWith(mappedProvider.toLowerCase()),
                  );

        return providerModels;
    }

    private async getModelInfo(model: string, provider?: string) {
        const providerModels = await this.getProviderModels(
            provider as BYOKProvider,
        );

        if (providerModels.length === 0) {
            throw new Error(`No models found for provider ${provider}`);
        }

        const parsedModel = model.toLowerCase().split('/').pop();

        const modelInfo = providerModels.find(
            (m) => m.id.split('/')[1] === parsedModel,
        );

        if (!modelInfo) {
            const availableModels = provider
                ? providerModels.map((m) => m.id.slice(provider.length + 1))
                : providerModels.map((m) => m.id);

            throw new Error(
                `Model ${model} not found for provider ${provider}. Available models: ${availableModels.join(', ')}`,
            );
        }

        // Ensure pricing values are numbers, not strings
        const pricing = {
            prompt: Number(modelInfo.pricing.prompt),
            completion: Number(modelInfo.pricing.completion),
            internal_reasoning: Number(modelInfo.pricing.internal_reasoning),
        };

        return {
            ...modelInfo,
            pricing,
        };
    }
}
