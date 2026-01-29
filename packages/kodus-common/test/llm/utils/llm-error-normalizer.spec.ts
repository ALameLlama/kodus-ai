import { LLMErrorNormalizer } from '../../../src/llm/utils/llm-error-normalizer';

describe('LLMErrorNormalizer', () => {
    it('should normalize parsing errors', () => {
        expect(
            LLMErrorNormalizer.normalize(new Error('Failed to parse output'))
                .message,
        ).toBe('AI Output Invalid (Parsing Failed)');
        expect(
            LLMErrorNormalizer.normalize(
                new Error('OUTPUT_PARSING_FAILURE detected'),
            ).message,
        ).toBe('AI Output Invalid (Parsing Failed)');
    });

    it('should normalize JSON correction errors', () => {
        expect(
            LLMErrorNormalizer.normalize(
                new Error('Failed to correct JSON output'),
            ).message,
        ).toBe('AI Output Invalid (Correction Failed)');
    });

    it('should normalize timeout errors', () => {
        expect(
            LLMErrorNormalizer.normalize(new Error('Request timed out'))
                .message,
        ).toBe('AI Request Timed Out');
        expect(
            LLMErrorNormalizer.normalize(
                new Error('TimeoutError: operation took too long'),
            ).message,
        ).toBe('AI Request Timed Out');
    });

    it('should normalize Zod validation errors', () => {
        const zodError = JSON.stringify([
            {
                code: 'invalid_type',
                expected: 'string',
                received: 'number',
                path: ['name'],
                message: 'Expected string, received number',
            },
        ]);
        expect(LLMErrorNormalizer.normalize(new Error(zodError)).message).toBe(
            'AI Output Schema Mismatch',
        );

        expect(
            LLMErrorNormalizer.normalize(
                new Error('Some error containing invalid_type code'),
            ).message,
        ).toBe('AI Output Schema Mismatch');
    });

    it('should normalize empty input errors', () => {
        expect(
            LLMErrorNormalizer.normalize(new Error('Input text is empty'))
                .message,
        ).toBe('AI returned empty response');
    });
});
