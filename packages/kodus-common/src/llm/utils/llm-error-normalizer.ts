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

        let normalizedMsg = msg;

        if (
            msg.includes('credit balance') ||
            msg.includes('insufficient_quota')
        ) {
            normalizedMsg = 'Insufficient AI Credits';
        } else if (
            msg.includes('context length') ||
            msg.includes('maximum context length')
        ) {
            normalizedMsg = 'Content exceeds AI token limit';
        } else if (
            msg.includes('Failed to parse') ||
            msg.includes('OUTPUT_PARSING_FAILURE')
        ) {
            normalizedMsg = 'AI Output Invalid (Parsing Failed)';
        } else if (msg.includes('Failed to correct JSON')) {
            normalizedMsg = 'AI Output Invalid (Correction Failed)';
        } else if (
            msg.includes('Request timed out') ||
            msg.includes('TimeoutError')
        ) {
            normalizedMsg = 'AI Request Timed Out';
        } else if (msg.includes('invalid_type')) {
            normalizedMsg = 'AI Output Schema Mismatch';
        } else if (msg.includes('503') || msg.includes('fetch failed')) {
            normalizedMsg = 'AI Service Unavailable (Network/Timeout)';
        } else if (msg.includes('429') || msg.includes('rate limit')) {
            normalizedMsg = 'AI Rate Limit Exceeded';
        } else if (msg.includes('Input text is empty')) {
            normalizedMsg = 'AI returned empty response';
        }

        if (error instanceof Error) {
            error.message = normalizedMsg;
            return error;
        }
        return new Error(normalizedMsg);
    }
}
