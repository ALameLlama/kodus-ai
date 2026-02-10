#!/usr/bin/env npx ts-node

/**
 * Generates the static system prompt with default values.
 * Run this to get the exact prompt used in LangSmith eval.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

import {
    prompt_codereview_system_gemini_v2,
    prompt_codereview_user_gemini_v2,
    CodeReviewPayload,
} from '../../libs/common/utils/langchainCommon/prompts/configuration/codeReview';

// Generate system prompt with defaults (no dynamic content)
const defaultPayload: CodeReviewPayload = {
    languageResultPrompt: 'en-US',
};

const systemPrompt = prompt_codereview_system_gemini_v2(defaultPayload);

// User prompt template (uses variables)
const userPromptTemplate = `## Code Under Review
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

Use the PR summary to understand the intended changes, then simulate execution of the modified code (+lines) to detect bugs that will actually occur in production.
`;

// Output for promptfoo
const output = {
    systemPrompt,
    userPromptTemplate,
};

// Save to file
const outputPath = path.join(__dirname, 'generated-prompts.json');
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

console.log(`Generated prompts saved to: ${outputPath}`);
console.log(`System prompt length: ${systemPrompt.length} chars`);
console.log(`User prompt template length: ${userPromptTemplate.length} chars`);
