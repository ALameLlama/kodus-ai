export class LLMErrorNormalizer {
    static normalize(error: unknown): Error {
        let msg: string;

        if (error instanceof Error) {
            msg = error.message;
        } else if (
            typeof error === 'object' &&
            error !== null &&
            'message' in error
        ) {
            msg = String((error as Record<string, unknown>).message);
        } else {
            msg = String(error);
        }

        if (
            msg.includes('credit balance') ||
            msg.includes('insufficient_quota')
        ) {
            return new Error('Insufficient AI Credits');
        }
        if (
            msg.includes('context length') ||
            msg.includes('maximum context length')
        ) {
            return new Error('Content exceeds AI token limit');
        }
        if (
            msg.includes('Failed to parse') ||
            msg.includes('OUTPUT_PARSING_FAILURE')
        ) {
            return new Error('AI Output Invalid (Parsing Failed)');
        }
        if (msg.includes('Failed to correct JSON')) {
            return new Error('AI Output Invalid (Correction Failed)');
        }
        if (msg.includes('Request timed out') || msg.includes('TimeoutError')) {
            return new Error('AI Request Timed Out');
        }
        if (msg.includes('invalid_type')) {
            return new Error('AI Output Schema Mismatch');
        }
        if (msg.includes('503') || msg.includes('fetch failed')) {
            return new Error('AI Service Unavailable (Network/Timeout)');
        }
        if (msg.includes('429') || msg.includes('rate limit')) {
            return new Error('AI Rate Limit Exceeded');
        }
        if (msg.includes('Input text is empty')) {
            return new Error('AI returned empty response');
        }

        return error instanceof Error ? error : new Error(msg);
    }
}
