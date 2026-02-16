import * as JSON5 from 'json5';
import { jsonrepair } from 'jsonrepair';

/**
 * Advanced JSON Parser with robust error handling and cleaning
 * Based on enterprise-grade parsing patterns and 'jsonrepair' library
 */

// Legacy export for compatibility
const transformToValidJSON = (input: string): string => {
    try {
        return jsonrepair(input);
    } catch {
        return input;
    }
};

function tryParseJSONObject<T>(payload: string): T | null {
    if (!payload || typeof payload !== 'string') return null;
    const text = payload.trim();
    if (text.length === 0) return null;

    // 1. Standard JSON (Fastest & Strictest)
    try {
        return JSON.parse(text);
    } catch {
        // Continue
    }

    // 2. JSON5 (Supports comments, trailing commas, single quotes)
    try {
        return JSON5.parse(text);
    } catch {
        // Continue
    }

    // 3. jsonrepair (Fixes broken structure, unescaped chars, python-style booleans, etc.)
    try {
        const repaired = jsonrepair(text);
        return JSON.parse(repaired);
    } catch {
        // Continue
    }

    return null;
}

// Legacy export for compatibility
function stripCodeBlocks(text: string): string {
    // Simple strip for legacy compatibility
    // Use non-overlapping pattern to prevent ReDoS (removed \s* before closing ```)
    const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    if (match && match[1]) return match[1].trim();
    return text
        .replace(/^```json\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
}

/**
 * Enhanced JSON Parser with multiple fallback strategies
 */
export class EnhancedJSONParser {
    /**
     * Parse JSON using a robust pipeline strategy
     */
    static parse<T = unknown>(text: string): T | null {
        if (!text) return null;

        // 1. Try parsing the raw text directly
        let result = tryParseJSONObject<T>(text);
        if (result !== null) return result;

        // 2. Try to extract JSON object/array using indices (Robust extraction)
        // This helps when the LLM wraps JSON in explanation text without code blocks
        // or when there are multiple code blocks and we want the first valid one.

        const firstBrace = text.indexOf('{');
        const firstBracket = text.indexOf('[');

        let start = -1;
        let end = -1;

        // Determine if we are looking for object or array start
        if (
            firstBrace !== -1 &&
            (firstBracket === -1 || firstBrace < firstBracket)
        ) {
            start = firstBrace;
            end = text.lastIndexOf('}');
        } else if (firstBracket !== -1) {
            start = firstBracket;
            end = text.lastIndexOf(']');
        }

        if (start !== -1 && end !== -1 && end > start) {
            const candidate = text.substring(start, end + 1);
            // Only retry if candidate is different (meaning there was surrounding text)
            // or just retry anyway to be safe
            if (candidate.length < text.length || candidate.length > 0) {
                result = tryParseJSONObject<T>(candidate);
                if (result !== null) return result;
            }
        }

        // 3. Try extracting from markdown code blocks explicitly (Regex fallback)
        // Useful if the robust extraction failed due to unbalanced braces in the surrounding text
        // Use non-overlapping pattern to prevent ReDoS (removed \s* before closing ```)
        const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
        if (match && match[1]) {
            result = tryParseJSONObject<T>(match[1].trim());
            if (result !== null) return result;
        }

        return null;
    }

    /**
     * Parse with validation and detailed error reporting
     */
    static parseWithValidation<T>(
        text: string,
        schema?: (data: unknown) => data is T,
    ): { success: true; data: T } | { success: false; error: string } {
        try {
            const parsed = this.parse<T>(text);

            if (parsed === null) {
                return {
                    success: false,
                    error: 'Failed to parse JSON from input text',
                };
            }

            if (schema && !schema(parsed)) {
                return {
                    success: false,
                    error: 'Parsed data does not match expected schema',
                };
            }

            return {
                success: true,
                data: parsed,
            };
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown parsing error',
            };
        }
    }

    /**
     * Extract JSON from mixed content (text + JSON)
     */
    static extractJSON(text: string): string | null {
        if (!text) return null;
        try {
            return jsonrepair(text);
        } catch {
            // Fallback regex
            const jsonPattern = /(\{[\s\S]*\}|\[[\s\S]*\])/g;
            const matches = text.match(jsonPattern);
            if (matches) {
                return matches.reduce((longest, current) =>
                    current.length > longest.length ? current : longest,
                );
            }
            return null;
        }
    }

    /**
     * Extract JSON from LangChain structured response format
     */
    static extractFromLangChainResponse(text: string): unknown | null {
        try {
            // Try to parse the outer structure first
            const langChainResponse = this.parse<Record<string, unknown>>(text);

            const extractContentText = (value: unknown): string | null => {
                if (typeof value === 'string') {
                    return value;
                }

                if (Array.isArray(value)) {
                    const textParts = value
                        .map((item) => {
                            if (!item || typeof item !== 'object') return '';
                            const block = item as {
                                type?: string;
                                text?: unknown;
                            };
                            if (
                                block.type &&
                                block.type !== 'text' &&
                                block.type !== 'text_delta'
                            ) {
                                return '';
                            }
                            return typeof block.text === 'string'
                                ? block.text
                                : '';
                        })
                        .filter(Boolean);
                    return textParts.length ? textParts.join('\n') : null;
                }

                return null;
            };

            if (!langChainResponse || typeof langChainResponse !== 'object') {
                return null;
            }

            const candidates = [
                (langChainResponse as { content?: unknown }).content,
                (langChainResponse as { contentBlocks?: unknown })
                    .contentBlocks,
                (
                    langChainResponse as {
                        kwargs?: { content?: unknown };
                    }
                ).kwargs?.content,
            ];

            for (const candidate of candidates) {
                const contentText = extractContentText(candidate);
                if (!contentText) continue;
                const parsed = this.parse(contentText);
                if (parsed) return parsed;
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Clean and normalize JSON string
     */
    static cleanJSONString(text: string): string {
        try {
            return jsonrepair(text);
        } catch {
            return text.trim();
        }
    }
}

export { transformToValidJSON, tryParseJSONObject, stripCodeBlocks };
