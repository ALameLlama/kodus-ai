import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Callbacks } from '@langchain/core/callbacks/manager';

export interface AdapterBuildParams {
    model: string;
    apiKey: string;
    baseURL?: string;
    options?: {
        temperature?: number;
        maxTokens?: number;
        jsonMode?: boolean;
        maxReasoningTokens?: number;
        reasoningLevel?: 'low' | 'medium' | 'high';
        disableReasoning?: boolean;
        callbacks?: Callbacks;
    };
}

export interface ProviderAdapter {
    build(params: AdapterBuildParams): BaseChatModel;
}
