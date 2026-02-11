/**
 * Replicates the production output parser from:
 * - libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform.ts
 * - packages/kodus-common/src/utils/json/index.ts
 *
 * This ensures the eval tests parseability with the same logic used in production.
 */

function stripCodeBlocks(text) {
    const cleanText = text.replace(/^['"]|['"]$/g, '');
    // Try all ```json blocks, return the first one that parses as valid JSON
    const jsonMatches = cleanText.matchAll(/```json([\s\S]*?)```/g);
    for (const match of jsonMatches) {
        const content = match[1].trim();
        try {
            JSON.parse(content);
            return match[1];
        } catch {
            // Invalid JSON, try next block
        }
    }
    // Fallback: any code block containing JSON-like content
    const genericMatch = cleanText.match(/```(?:\w*)\s*([\s\S]*?)```/g);
    if (genericMatch) {
        for (const block of genericMatch) {
            const content = block.replace(/^```\w*\s*/, '').replace(/```$/, '').trim();
            if (content.startsWith('{') || content.startsWith('[')) {
                return content;
            }
        }
    }
    return cleanText;
}

function tryParseJSONObjectWithFallback(payload) {
    try {
        if (payload.length <= 0) return null;
        // JSON5 not available in promptfoo runtime, use JSON.parse directly
        return JSON.parse(payload);
    } catch {
        try {
            const noCodeBlocks = stripCodeBlocks(payload);
            const cleanedPayload = noCodeBlocks
                .replace(/\\n/g, '')
                .replace(/\\/g, '')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/<[^>]*>/g, '')
                .replace(/^`+|`+$/g, '')
                .trim();
            return JSON.parse(cleanedPayload);
        } catch {
            return null;
        }
    }
}

function tryParseJSONObject(payload) {
    try {
        const cleanedPayload = payload
            .replace(/\\\\n/g, '\\n')
            .replace(/\\'/g, "'")
            .replace(/(\r\n|\n|\r)/gm, '')
            .replace(/\\\\"/g, '\\"');

        const parsedData = tryParseJSONObjectWithFallback(cleanedPayload);

        if (parsedData && (typeof parsedData === 'object' || Array.isArray(parsedData))) {
            return parsedData;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Replicates LLMResponseProcessor.processResponse()
 * Returns { codeSuggestions: [...] } or null on parse failure.
 */
function processResponse(response) {
    try {
        let cleanResponse = response;

        // If response starts with ```, remove markdown markers (same as production)
        if (response?.startsWith('```')) {
            cleanResponse = response
                .replace(/^```json\n/, '')
                .replace(/\n```$/, '')
                .trim();
        }

        const parsedResponse = tryParseJSONObject(cleanResponse);

        if (!parsedResponse) {
            return null;
        }

        // Normalize line number types (same as production)
        if (parsedResponse?.codeSuggestions) {
            parsedResponse.codeSuggestions = parsedResponse.codeSuggestions.map((suggestion) => ({
                ...suggestion,
                relevantLinesStart: Number(suggestion.relevantLinesStart) || undefined,
                relevantLinesEnd: Number(suggestion.relevantLinesEnd) || undefined,
            }));
        }

        return {
            codeSuggestions: parsedResponse?.codeSuggestions || [],
        };
    } catch {
        return null;
    }
}

/**
 * Validates codeSuggestions structure against production Zod schema requirements.
 * Returns { valid: boolean, errors: string[] }
 */
function validateSchema(codeSuggestions) {
    const errors = [];
    if (!Array.isArray(codeSuggestions)) {
        return { valid: false, errors: ['codeSuggestions is not an array'] };
    }

    codeSuggestions.forEach((s, i) => {
        if (!s.relevantFile || typeof s.relevantFile !== 'string') {
            errors.push(`[${i}] missing or invalid relevantFile`);
        }
        if (!s.language || typeof s.language !== 'string') {
            errors.push(`[${i}] missing or invalid language`);
        }
        if (!s.suggestionContent || typeof s.suggestionContent !== 'string') {
            errors.push(`[${i}] missing or invalid suggestionContent`);
        }
        if (!s.improvedCode || typeof s.improvedCode !== 'string') {
            errors.push(`[${i}] missing or invalid improvedCode`);
        }
        if (!s.label || typeof s.label !== 'string') {
            errors.push(`[${i}] missing or invalid label`);
        }
        if (s.relevantLinesStart !== undefined && (typeof s.relevantLinesStart !== 'number' || s.relevantLinesStart < 1)) {
            errors.push(`[${i}] relevantLinesStart must be number >= 1, got ${s.relevantLinesStart}`);
        }
        if (s.relevantLinesEnd !== undefined && (typeof s.relevantLinesEnd !== 'number' || s.relevantLinesEnd < 1)) {
            errors.push(`[${i}] relevantLinesEnd must be number >= 1, got ${s.relevantLinesEnd}`);
        }
    });

    return { valid: errors.length === 0, errors };
}

module.exports = { processResponse, validateSchema, tryParseJSONObject, stripCodeBlocks };
