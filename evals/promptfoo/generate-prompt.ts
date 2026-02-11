#!/usr/bin/env npx ts-node

/**
 * Regenerates the prompt JSON from the codebase.
 * Run this after changing the code review prompt.
 *
 * Usage: yarn eval:codereview:generate-prompt
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    prompt_codereview_system_gemini_v2,
} from '../../libs/common/utils/langchainCommon/prompts/configuration/codeReview';
import {
    V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT,
    V2_DEFAULT_SEVERITY_FLAGS_TEXT,
} from '../../libs/common/utils/codeReview/v2Defaults';

const systemPrompt = prompt_codereview_system_gemini_v2({
    languageResultPrompt: 'en-US',
    v2PromptOverrides: {
        categories: {
            descriptions: V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT,
        },
        severity: {
            flags: V2_DEFAULT_SEVERITY_FLAGS_TEXT,
        },
    },
});

const userPrompt = `## Code Under Review
Mentally execute the changed code through multiple scenarios and identify real bugs that will break in production.

PR Summary:
\`\`\`
{{prSummary}}
\`\`\`

Complete File Content:
\`\`\`
{{fileContent}}
\`\`\`

Code Diff (PR Changes):
\`\`\`
{{patchWithLinesStr}}
\`\`\`

Use the PR summary to understand the intended changes, then simulate execution of the modified code (+lines) to detect bugs that will actually occur in production.`;

const prompt = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
];

const outputPath = path.join(__dirname, 'generated-prompt.json');
fs.writeFileSync(outputPath, JSON.stringify(prompt, null, 2));

console.log(`Prompt generated: ${outputPath}`);
console.log(`System prompt length: ${systemPrompt.length} chars`);
