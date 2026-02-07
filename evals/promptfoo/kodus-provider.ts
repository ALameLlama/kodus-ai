/**
 * Custom Promptfoo provider that uses the exact same prompt as LangSmith eval.
 * This ensures identical prompts and payload structure.
 */

import {
    prompt_codereview_system_gemini_v2,
    prompt_codereview_user_gemini_v2,
    CodeReviewPayload,
} from '../../libs/common/utils/langchainCommon/prompts/configuration/codeReview';

interface PromptfooVars {
    filePath?: string;
    language?: string;
    fileContent?: string;
    patchWithLinesStr?: string;
    reviewOptions?: string;
    prSummary?: string;
    languageResultPrompt?: string;
}

/**
 * Builds the exact same payload structure used in LangSmith eval
 */
function buildPayload(vars: PromptfooVars): CodeReviewPayload {
    return {
        fileContent: vars.fileContent,
        patchWithLinesStr: vars.patchWithLinesStr,
        relevantContent: vars.fileContent,
        languageResultPrompt: vars.languageResultPrompt || 'en-US',
        prSummary: vars.prSummary,
    };
}

/**
 * Generates the system prompt using the exact Kodus function
 */
export function generateSystemPrompt(vars: PromptfooVars): string {
    const payload = buildPayload(vars);
    return prompt_codereview_system_gemini_v2(payload);
}

/**
 * Generates the user prompt using the exact Kodus function
 */
export function generateUserPrompt(vars: PromptfooVars): string {
    const payload = buildPayload(vars);
    return prompt_codereview_user_gemini_v2(payload);
}

/**
 * Generates the full prompt array for promptfoo
 */
export function generatePrompt(vars: PromptfooVars): Array<{ role: string; content: string }> {
    const payload = buildPayload(vars);

    return [
        {
            role: 'system',
            content: prompt_codereview_system_gemini_v2(payload),
        },
        {
            role: 'user',
            content: prompt_codereview_user_gemini_v2(payload),
        },
    ];
}

// Default export for promptfoo prompt function
export default generatePrompt;
