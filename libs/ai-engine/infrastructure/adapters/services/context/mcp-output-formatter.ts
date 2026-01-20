export type JsonParser = (value: string) => unknown | null;

const NO_OUTPUT_TEXT = 'No output returned.';

export function formatMCPOutput(
    result: unknown,
    parseJSON: JsonParser,
): string {
    if (result === null || result === undefined) {
        return NO_OUTPUT_TEXT;
    }

    if (typeof result === 'string') {
        return formatTextOrJSON(result, parseJSON);
    }

    const structured = formatStructuredContent(result, parseJSON);
    if (structured) {
        return structured;
    }

    try {
        return wrapAsJSON(result);
    } catch {
        return String(result);
    }
}

function formatStructuredContent(
    result: unknown,
    parseJSON: JsonParser,
): string | null {
    const contentItems = extractStructuredContentArray(result);
    if (!contentItems?.length) {
        return null;
    }

    const formatted = contentItems
        .map((item) => formatStructuredContentItem(item, parseJSON))
        .filter((block): block is string => Boolean(block?.trim()));

    return formatted.length ? formatted.join('\n\n') : null;
}

function extractStructuredContentArray(result: unknown): unknown[] | null {
    if (Array.isArray(result)) {
        return result;
    }

    if (
        result &&
        typeof result === 'object' &&
        Array.isArray((result as Record<string, unknown>).content)
    ) {
        return (result as Record<string, unknown>).content as unknown[];
    }

    return null;
}

function formatStructuredContentItem(
    item: unknown,
    parseJSON: JsonParser,
): string | null {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const entry = item as Record<string, unknown>;
    const type =
        typeof entry.type === 'string' ? (entry.type as string) : undefined;

    if (type === 'text' && typeof entry.text === 'string') {
        return formatTextOrJSON(entry.text, parseJSON);
    }

    if (type === 'code' && typeof entry.text === 'string') {
        const language =
            typeof entry.language === 'string' ? entry.language : '';
        return `\`\`\`${language}\n${entry.text}\n\`\`\``.trim();
    }

    if (entry.text && typeof entry.text === 'string') {
        return entry.text;
    }

    if (entry.data !== undefined) {
        return stringifyValue(entry.data, parseJSON);
    }

    return stringifyValue(entry, parseJSON);
}

function formatTextOrJSON(text: string, parseJSON: JsonParser): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return text;
    }

    if (looksLikeJSON(trimmed)) {
        const parsed = parseJSON(trimmed);
        if (parsed !== null) {
            return wrapAsJSON(parsed);
        }
    }

    return text;
}

function stringifyValue(value: unknown, parseJSON: JsonParser): string {
    if (value === null || value === undefined) {
        return String(value);
    }

    if (typeof value === 'string') {
        return formatTextOrJSON(value, parseJSON);
    }

    try {
        return wrapAsJSON(value);
    } catch {
        return String(value);
    }
}

function looksLikeJSON(value: string): boolean {
    const trimmed = value.trim();
    return (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
    );
}

function wrapAsJSON(value: unknown): string {
    return `\`\`\`mcp-result\n${JSON.stringify(value)}\n\`\`\``;
}
