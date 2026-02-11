import * as JSON5 from 'json5';

const transformToValidJSON = (input: string): string => {
    // Replaces unescaped single quotes with double quotes
    return input.replace(/(?<!\\)'/g, '"');
};

function tryParseJSONObject<T>(payload: string): T | null {
    try {
        const cleanedPayload = payload
            .replace(/\\\\n/g, '\\n') // Transform '\\\\n' into '\n'
            .replace(/\\'/g, "'") // Fix escaped single quotes
            .replace(/(\r\n|\n|\r)/gm, '') // Remove newlines outside of strings
            .replace(/\\\\"/g, '\\"');

        const parsedData = tryParseJSONObjectWithFallback<T>(cleanedPayload);

        if (
            parsedData &&
            (typeof parsedData === 'object' || Array.isArray(parsedData))
        ) {
            return parsedData;
        }

        return null;
    } catch (err) {
        console.log('Error handling the return object from the LLM', err);
        return null;
    }
}

function tryParseJSONObjectWithFallback<T>(payload: string): T | null {
    try {
        if (payload.length <= 0) {
            return null;
        }

        return JSON5.parse(payload);
    } catch {
        try {
            return JSON.parse(payload) as T;
        } catch {
            try {
                const noCodeBlocks = stripCodeBlocks(payload);
                const cleanedPayload = noCodeBlocks
                    .replace(/\\n/g, '') // Remove newline characters
                    .replace(/\\/g, '') // Remove backslashes (escape characters)
                    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments (/* comment */)
                    .replace(/<[^>]*>/g, '') // Remove HTML tags (e.g., <tag>)
                    .replace(/^`+|`+$/g, '') // Remove backticks at the beginning and end
                    .trim();

                return JSON.parse(cleanedPayload) as T;
            } catch {
                return null;
            }
        }
    }
}

function stripCodeBlocks(text: string): string {
    // Remove quotes at the beginning and end if they exist
    const cleanText = text.replace(/^['"]|['"]$/g, '');

    // Extract the content between ```json and ```
    const match = cleanText.match(/```json({[\s\S]*?})```/);
    if (match && match[1]) {
        return match[1];
    }

    return cleanText;
}

export { transformToValidJSON, tryParseJSONObject };
